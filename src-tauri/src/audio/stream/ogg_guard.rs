/*
 * The Ogg guard: walks the Ogg pages of a stream as the bytes pass to symphonia, and refuses a
 * header packet whose sizes would make symphonia allocate from them, before symphonia holds the
 * page that completes it.
 *
 * It is a first layer: it refuses the known hostile shapes early and cleanly. It does not by
 * itself make symphonia safe on hostile Ogg. A second parser cannot follow symphonia's state on
 * every path, and one known miss is a header packet whose chain moves on to a later page and is
 * then completed after a seek back to the page where it was first cut.
 *
 * symphonia 0.5.5's mappers parse header packets from memory: the Vorbis comment (Vorbis, Opus and
 * FLAC-in-Ogg), the FLAC picture block (FLAC-in-Ogg, and inside a `METADATA_BLOCK_PICTURE`
 * comment) and the Vorbis setup header, whose codebooks the Vorbis decoder builds. A Vorbis or FLAC
 * mapper parses such a packet wherever it appears, so the guard stays on for the whole stream.
 *
 * Which pages symphonia reads as data, and in which order, depends on where it is in opening a
 * physical stream and on the seeks it makes while opening, which the guard cannot see from the
 * bytes. So the guard checks wider than any one path:
 * - Pages: from any position the source is read at, the guard runs symphonia's page sync over
 *   the same bytes ("OggS", version and flags, CRC, the search resuming four bytes into a page that
 *   fails its CRC), so every page symphonia can accept from that position is one the guard sees.
 * - Mappings: a logical stream is checked for every mapping its first pages have announced. No
 *   stream is ever forgotten, since symphonia may still read one the guard dropped; each keeps one
 *   byte, and past `OGG_SERIALS_MAX` streams the whole stream is refused.
 * - Packets: a packet that starts and ends on one page is checked on its own. A packet that
 *   continues across pages is a chain, kept from the boundary where it was cut. symphonia's own
 *   partial packet continues on the next page of its logical stream along a run of contiguous
 *   reads, and a seek it makes while opening returns to a page boundary of that run. So a chain is
 *   continued on the next page of its stream along any read run that passes its latest boundary
 *   or a later one before that page; once continued, it keeps only its newest boundary.
 *
 * The bytes are kept in a fixed window allocated once per stream: an audio page costs one copy
 * into it and one CRC pass, with no allocation.
 */

// -- Library Imports --
use std::collections::HashMap;

use symphonia::core::checksum::Crc32;
use symphonia::core::io::Monitor;

// -- Local Imports --
use super::comment_check::{CommentCheck, PictureCheck};
use super::guard::Refused;
use super::vorbis_setup::{check_setup, VORBIS_SETUP_MAX};

/// The largest Ogg header packet (comment, picture or setup), cover art included. An audio packet
/// is held by symphonia's own limit of 16 MiB per packet.
pub const OGG_PACKET_MAX: usize = 8 << 20;

/// The most logical streams one run of first pages may announce.
pub const OGG_STREAMS_MAX: usize = 8;

/// The most setup header bytes read over a stream's life: a mapper appends every setup packet it
/// reads, a re-read after a seek included, to its codec setup with a full copy.
pub const VORBIS_SETUP_TOTAL_MAX: u64 = 4 << 20;

// The window holds at most one unfinished page and the read being fed.
const WINDOW: usize = 1 << 17;

/// The most logical streams the guard tracks over a stream's life. None is ever forgotten; one
/// more is refused. A chained live stream starts one per link: at one link per 3-minute track this
/// is 34 days of continuous play. Each stream keeps only its serial and the mappings announced for
/// it, one entry of a hash map (8 bytes and a control byte, at most 8 in 7 slots used, rounded up
/// to a power of two): at the cap, 32,768 slots, under 300 KiB.
pub const OGG_SERIALS_MAX: usize = 16_384;

// Header packets continued across pages held at once; real streams hold one per logical stream.
const CHAINS_MAX: usize = 32;

// Page boundaries a chain records while it waits for its next page.
const MARKS_MAX: usize = 64;

const VORBIS: usize = 0;
const OPUS: usize = 1;
const FLAC: usize = 2;

#[derive(Clone)]
enum Kind {
    Absent,
    Undecided,
    Plain,
    Comment(CommentCheck),
    Picture(PictureCheck),
    Setup(Vec<u8>),
}

// The bytes that tell a header packet from audio, per mapping.
const PREFIX: [usize; 3] = [7, 8, 4];

// The kind of packet its first bytes make it for one mapping.
fn decide(codec: usize, prefix: &[u8]) -> Kind {
    match codec {
        VORBIS if prefix[0] & 1 == 1 && &prefix[1..7] == b"vorbis" => match prefix[0] {
            3 => Kind::Comment(CommentCheck::new()),
            5 => Kind::Setup(prefix.to_vec()),
            _ => Kind::Plain,
        },
        OPUS if prefix == b"OpusTags" => Kind::Comment(CommentCheck::new()),
        // FLAC-in-Ogg: 0xFF is audio, 0x00 and 0x80 are ignored; anything else is a metadata block.
        FLAC if !matches!(prefix[0], 0xFF | 0x00 | 0x80) => match prefix[0] & 0x7F {
            4 => Kind::Comment(CommentCheck::new()),
            6 => Kind::Picture(PictureCheck::new()),
            _ => Kind::Plain,
        },
        _ => Kind::Plain,
    }
}

// A packet being assembled, checked for each mapping its stream may have.
#[derive(Clone)]
struct Packet {
    len: usize,
    prefix: [u8; 8],
    kinds: [Kind; 3],
}

impl Packet {
    fn new(codecs: u8) -> Self {
        let kind = |i: usize| {
            if codecs & (1 << i) != 0 {
                Kind::Undecided
            } else {
                Kind::Absent
            }
        };
        Self {
            len: 0,
            prefix: [0; 8],
            kinds: [kind(VORBIS), kind(OPUS), kind(FLAC)],
        }
    }

    // Whether any mapping may still parse this packet as a header.
    fn is_header(&self) -> bool {
        self.kinds.iter().any(|k| {
            matches!(
                k,
                Kind::Undecided | Kind::Comment(_) | Kind::Picture(_) | Kind::Setup(_)
            )
        })
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<(), Refused> {
        let start = self.len;
        self.len += bytes.len();
        let n = 8usize.saturating_sub(start).min(bytes.len());
        if n > 0 {
            self.prefix[start..start + n].copy_from_slice(&bytes[..n]);
        }
        for (codec, kind) in self.kinds.iter_mut().enumerate() {
            let need = PREFIX[codec];
            let mut rest = bytes;
            if matches!(kind, Kind::Undecided) {
                if self.len < need {
                    continue;
                }
                // The prefix is in already; the bytes of this feed past it follow.
                *kind = decide(codec, &self.prefix[..need]);
                rest = &bytes[need.saturating_sub(start).min(bytes.len())..];
            }
            match kind {
                Kind::Comment(c) => c.feed(rest),
                Kind::Picture(p) => p.feed(rest),
                Kind::Setup(buf) => {
                    if buf.len() + rest.len() > VORBIS_SETUP_MAX {
                        return Err(Refused);
                    }
                    buf.extend_from_slice(rest);
                }
                _ => {}
            }
        }
        if self.is_header() && self.len > OGG_PACKET_MAX {
            return Err(Refused);
        }
        Ok(())
    }

    // The packet is complete: check it as each mapping would parse it. Returns the setup header
    // bytes a mapper would take in.
    fn finish(&self) -> Result<u64, Refused> {
        let mut setup = 0;
        for kind in &self.kinds {
            match kind {
                Kind::Comment(c) => c.finish()?,
                Kind::Picture(p) => p.finish()?,
                Kind::Setup(buf) => {
                    check_setup(buf)?;
                    setup = buf.len() as u64;
                }
                _ => {}
            }
        }
        Ok(setup)
    }
}

// The mapping symphonia picks for a logical stream from its first packet, as a bit of `VORBIS`,
// `OPUS`, `FLAC`. Each test is no stricter than symphonia's.
fn detect(first: &[u8]) -> u8 {
    if first.starts_with(b"\x7FFLAC") {
        1 << FLAC
    } else if first.starts_with(b"\x01vorbis") {
        1 << VORBIS
    } else if first.starts_with(b"OpusHead") {
        1 << OPUS
    } else {
        0
    }
}

// A header packet continued across pages, waiting for the next page of its stream.
struct Chain {
    serial: u32,
    seq: u32,
    // Where the packet started, to tell a re-read of the same chain from a new one.
    origin: u64,
    packet: Packet,
    // The page boundaries it was cut at or waited past, in order; past `MARKS_MAX`, any position
    // after the first counts.
    marks: Vec<u64>,
    overflow: bool,
    // The read run it continues on, if any.
    armed: Option<u64>,
}

impl Chain {
    fn arms_at(&self, pos: u64) -> bool {
        self.marks.contains(&pos) || (self.overflow && pos >= self.marks[0])
    }
}

/// The page walker. Fed every byte the demuxer reads, in order, with each seek in between.
pub(crate) struct OggGuard {
    win: Vec<u8>,
    // The absolute position of `win[0]`, and of the next page search.
    base: u64,
    scan: u64,
    state: State,
}

// What the guard knows of the logical streams, apart from the bytes.
struct State {
    // The current read run: it starts at the last seek.
    run: u64,
    // Each logical stream ever announced, and the mappings (bits of `VORBIS`, `OPUS`, `FLAC`)
    // its first pages announced. A hash map, so a page's lookup does not grow with the count.
    serials: HashMap<u32, u8>,
    chains: Vec<Chain>,
    first_pages: usize,
    setup_bytes: u64,
}

impl OggGuard {
    pub(crate) fn new() -> Self {
        Self {
            win: Vec::with_capacity(WINDOW),
            base: 0,
            scan: 0,
            state: State {
                run: 0,
                serials: HashMap::new(),
                chains: Vec::new(),
                first_pages: 0,
                setup_bytes: 0,
            },
        }
    }

    /// Takes `bytes` read at `pos`. Bytes already seen are skipped; a gap is refused.
    pub(crate) fn feed(&mut self, pos: u64, bytes: &[u8]) -> Result<(), Refused> {
        let end = self.base + self.win.len() as u64;
        if pos > end {
            return Err(Refused);
        }
        let seen = ((end - pos) as usize).min(bytes.len());
        let mut bytes = &bytes[seen..];
        while !bytes.is_empty() {
            let n = (WINDOW - self.win.len()).min(bytes.len());
            if n == 0 {
                return Err(Refused);
            }
            self.win.extend_from_slice(&bytes[..n]);
            bytes = &bytes[n..];
            self.scan_pages()?;
            let done = (self.scan - self.base) as usize;
            self.win.drain(..done);
            self.base = self.scan;
        }
        Ok(())
    }

    /// Takes a seek of the source to `pos`: a new read run starts there, and the chains waiting
    /// at that boundary continue on it.
    pub(crate) fn seeked(&mut self, pos: u64) {
        self.win.clear();
        self.base = pos;
        self.scan = pos;
        self.state.run += 1;
        // A run of first pages is counted along contiguous reads only.
        self.state.first_pages = 0;
        let run = self.state.run;
        for c in &mut self.state.chains {
            c.armed = c.arms_at(pos).then_some(run);
        }
    }

    // Accepts every complete page in the window, as symphonia's page reader would.
    fn scan_pages(&mut self) -> Result<(), Refused> {
        loop {
            let from = (self.scan - self.base) as usize;
            let data = &self.win[from..];
            let Some(at) = data.windows(4).position(|w| w == b"OggS") else {
                // Keep the last three bytes: a capture pattern may straddle the next read.
                self.scan += data.len().saturating_sub(3) as u64;
                return Ok(());
            };
            self.scan += at as u64;
            let page = &self.win[from + at..];
            if page.len() < 27 {
                return Ok(());
            }
            if page[4] != 0 || page[5] & 0xF8 != 0 {
                self.scan += 27;
                continue;
            }
            let segments = page[26] as usize;
            if page.len() < 27 + segments {
                return Ok(());
            }
            let body: usize = page[27..27 + segments].iter().map(|&b| b as usize).sum();
            let total = 27 + segments + body;
            if page.len() < total {
                return Ok(());
            }
            let mut crc = Crc32::new(0);
            crc.process_buf_bytes(&page[..22]);
            crc.process_buf_bytes(&[0; 4]);
            crc.process_buf_bytes(&page[26..total]);
            if crc.crc() != u32::from_le_bytes([page[22], page[23], page[24], page[25]]) {
                self.scan += 4;
                continue;
            }
            let start = from + at;
            self.state
                .take_page(self.scan, &self.win[start..start + total])?;
            self.scan += total as u64;
        }
    }
}

impl State {
    fn take_page(&mut self, pos: u64, page: &[u8]) -> Result<(), Refused> {
        let flags = page[5];
        let continued = flags & 0x01 != 0;
        let first_page = flags & 0x02 != 0;
        let serial = u32::from_le_bytes([page[14], page[15], page[16], page[17]]);
        let seq = u32::from_le_bytes([page[18], page[19], page[20], page[21]]);
        let segments = page[26] as usize;
        let table = &page[27..27 + segments];
        let body = &page[27 + segments..];
        let end = pos + page.len() as u64;

        // Packet ranges: complete packets, then the cut packet, if any.
        let mut complete = 0usize;
        let mut first_len = None;
        let mut len = 0;
        for &seg in table {
            len += seg as usize;
            if seg < 255 {
                complete += 1;
                first_len.get_or_insert(len);
                len = 0;
            }
        }

        if first_page {
            self.first_pages += 1;
            if self.first_pages > OGG_STREAMS_MAX {
                return Err(Refused);
            }
            if let Some(n) = first_len {
                let codecs = detect(&body[..n]);
                *self.serial_mut(serial)? |= codecs;
            }
        } else {
            self.first_pages = 0;
        }
        let codecs = self.serials.get(&serial).copied().unwrap_or(0);

        let run = self.run;
        // Every other stream's chain waiting on this run waits past this page.
        for c in self.chains.iter_mut() {
            if c.armed == Some(run) && c.serial != serial {
                if c.marks.len() < MARKS_MAX {
                    c.marks.push(end);
                } else {
                    c.overflow = true;
                }
            }
        }
        if codecs == 0 {
            return Ok(());
        }

        // This stream's chains waiting on this run end here: continued, or cleared as symphonia
        // clears a partial packet on a gap in sequence or a page that does not continue it.
        let mut waiting = Vec::new();
        let mut i = 0;
        while i < self.chains.len() {
            let c = &self.chains[i];
            if c.serial == serial && c.armed == Some(run) {
                waiting.push(self.chains.swap_remove(i));
            } else {
                i += 1;
            }
        }
        let mut offset = 0;
        if continued {
            let first = first_len.unwrap_or(body.len());
            for mut c in waiting {
                if seq < c.seq || seq - c.seq > 1 {
                    continue;
                }
                c.packet.feed(&body[..first])?;
                if complete > 0 {
                    self.finished(&c.packet)?;
                } else {
                    self.keep(Chain {
                        serial,
                        seq,
                        origin: c.origin,
                        packet: c.packet,
                        marks: vec![end],
                        overflow: false,
                        armed: Some(run),
                    })?;
                }
            }
            // Without a partial packet symphonia drops this first piece; with one it completed it.
            if complete == 0 {
                return Ok(());
            }
            offset = first;
        }

        let mut len = 0;
        let mut skipped = continued;
        for &seg in table {
            len += seg as usize;
            if seg == 255 {
                continue;
            }
            if skipped {
                skipped = false;
                len = 0;
                continue;
            }
            let mut packet = Packet::new(codecs);
            packet.feed(&body[offset..offset + len])?;
            if packet.is_header() {
                self.finished(&packet)?;
            }
            offset += len;
            len = 0;
        }
        if offset < body.len() {
            let mut packet = Packet::new(codecs);
            packet.feed(&body[offset..])?;
            if packet.is_header() {
                self.keep(Chain {
                    serial,
                    seq,
                    origin: pos,
                    packet,
                    marks: vec![end],
                    overflow: false,
                    armed: Some(run),
                })?;
            }
        }
        Ok(())
    }

    fn finished(&mut self, packet: &Packet) -> Result<(), Refused> {
        self.setup_bytes += packet.finish()?;
        if self.setup_bytes > VORBIS_SETUP_TOTAL_MAX {
            return Err(Refused);
        }
        Ok(())
    }

    // Stores a chain; a re-read of the same chain replaces it.
    fn keep(&mut self, chain: Chain) -> Result<(), Refused> {
        self.chains.retain(|c| {
            !(c.serial == chain.serial && c.origin == chain.origin && c.marks[0] == chain.marks[0])
        });
        if self.chains.len() == CHAINS_MAX {
            return Err(Refused);
        }
        self.chains.push(chain);
        Ok(())
    }

    // A stream is never forgotten: symphonia skips first pages of streams it does not know, so
    // a forgotten stream could still be one symphonia reads. One past the cap is refused.
    fn serial_mut(&mut self, serial: u32) -> Result<&mut u8, Refused> {
        if !self.serials.contains_key(&serial) && self.serials.len() == OGG_SERIALS_MAX {
            return Err(Refused);
        }
        Ok(self.serials.entry(serial).or_insert(0))
    }
}

#[cfg(test)]
mod tests;
