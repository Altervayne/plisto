/*
 * The MP4 guard: walks the atom tree of a finite MP4 before symphonia opens it, and refuses a file
 * whose tables or boxes would make symphonia allocate from sizes the file declares.
 *
 * symphonia's MP4 reader sizes a vector from each sample-table count before reading the entries,
 * reads metadata items, the handler name and codec boxes whole at the length they declare, sizes a
 * buffer from an esds descriptor length that no atom length bounds, and reads each sample at the
 * size `stsz` gives it. The ALAC decoder sizes its frame buffer from the magic cookie. Every one of
 * those fields is checked here against the bytes that hold it and against the caps below.
 *
 * The walk runs up front, over the growing buffer, because `moov` may sit after `mdat`: symphonia
 * walks every top-level atom of a seekable file before it plays, so waiting for the walk costs
 * nothing extra. It reads headers and small fields, and steps over everything else with seeks; a
 * sample size table is read through a small scratch buffer. Fragmented files (`moof`, `mvex`,
 * `sidx`, `mfra`) are refused: streams do not play them.
 */

// -- Library Imports --
use std::io::{Read, Seek, SeekFrom};

// -- Local Imports --
use super::guard::Refused;

/// The largest `moov` (and top-level `meta`). With `MP4_ENTRIES_MAX` it bounds every table.
pub const MOOV_MAX: u64 = 16 << 20;

/// The most entries in one sample table (`stsz`, `stco`, `co64`, `stts`, `stsc`). 2^21 AAC frames
/// of 1,024 samples are 13 hours at 44.1 kHz. symphonia keeps at most 8 bytes per entry (`co64`
/// and `stco` as u64, `stsc` as 16-byte rows from 12-byte ones), so one table costs at most 32 MiB.
pub const MP4_ENTRIES_MAX: u32 = 1 << 21;

/// The most entries in an edit list; real files hold one or two.
pub const MP4_EDITS_MAX: u32 = 4_096;

/// The largest single sample `stsz` may declare.
pub const MP4_SAMPLE_MAX: u32 = 1 << 20;

/// The largest metadata `data` item: room for cover art.
pub const MP4_ITEM_MAX: u64 = 8 << 20;

/// The largest small box read whole: `hdlr`, `esds`, `alac`, `dfLa`, `dOps`, `ftyp`, `name`, `mean`.
pub const MP4_BOX_MAX: u64 = 64 * 1_024;

/// The largest ALAC frame length a magic cookie may declare; encoders write 4,096.
pub const ALAC_FRAME_MAX: u32 = 16_384;

/// The most frames per packet a version 2 LPCM sample entry may declare.
pub const LPCM_FRAMES_MAX: u32 = 1 << 16;

// The sample entry types symphonia parses as audio.
const AUDIO_ENTRIES: [&[u8; 4]; 16] = [
    b"mp4a", b"alac", b"fLaC", b"Opus", b".mp3", b"lpcm", b"wave", b"alaw", b"ulaw", b"raw ",
    b"sowt", b"twos", b"in24", b"in32", b"fl32", b"fl64",
];

struct Walk<'a, R> {
    src: &'a mut R,
}

// One atom: its type, where its payload starts, and where it ends.
struct Atom {
    kind: [u8; 4],
    body: u64,
    end: u64,
}

impl Atom {
    fn len(&self) -> u64 {
        self.end - self.body
    }
}

impl<R: Read + Seek> Walk<'_, R> {
    fn read_at(&mut self, pos: u64, buf: &mut [u8]) -> Result<(), Refused> {
        self.src.seek(SeekFrom::Start(pos)).map_err(|_| Refused)?;
        self.src.read_exact(buf).map_err(|_| Refused)
    }

    fn u32_at(&mut self, pos: u64) -> Result<u32, Refused> {
        let mut b = [0u8; 4];
        self.read_at(pos, &mut b)?;
        Ok(u32::from_be_bytes(b))
    }

    // The atom at `pos`, which must end by `end`. A size of 0 (to the end) is allowed only for a
    // top-level `mdat`, where `open_ended` says so.
    fn atom(&mut self, pos: u64, end: u64, open_ended: bool) -> Result<Atom, Refused> {
        if end - pos < 8 {
            return Err(Refused);
        }
        let mut head = [0u8; 8];
        self.read_at(pos, &mut head)?;
        let kind = [head[4], head[5], head[6], head[7]];
        let (size, header) = match u32::from_be_bytes([head[0], head[1], head[2], head[3]]) {
            // symphonia reads a size-0 atom as empty, so only `mdat`, whose payload it never
            // parses, may run to the end.
            0 if open_ended && &kind == b"mdat" => (end - pos, 8),
            0 => return Err(Refused),
            1 => {
                if end - pos < 16 {
                    return Err(Refused);
                }
                let mut large = [0u8; 8];
                self.read_at(pos + 8, &mut large)?;
                (u64::from_be_bytes(large), 16)
            }
            n => (n as u64, 8),
        };
        if size < header || size > end - pos {
            return Err(Refused);
        }
        Ok(Atom {
            kind,
            body: pos + header,
            end: pos + size,
        })
    }

    // Visits each child atom in `[pos, end)`.
    fn children(
        &mut self,
        mut pos: u64,
        end: u64,
        mut visit: impl FnMut(&mut Self, &Atom) -> Result<(), Refused>,
    ) -> Result<(), Refused> {
        while pos < end {
            let atom = self.atom(pos, end, false)?;
            visit(self, &atom)?;
            pos = atom.end;
        }
        Ok(())
    }

    fn top(&mut self, len: u64) -> Result<(), Refused> {
        let mut pos = 0;
        while pos < len {
            let atom = self.atom(pos, len, true)?;
            match &atom.kind {
                b"moov" | b"meta" if atom.len() > MOOV_MAX => return Err(Refused),
                b"moov" => self.moov(&atom)?,
                b"meta" => self.meta(&atom)?,
                b"ftyp" if atom.len() > MP4_BOX_MAX => return Err(Refused),
                b"moof" | b"mvex" | b"sidx" | b"mfra" => return Err(Refused),
                _ => {}
            }
            pos = atom.end;
        }
        Ok(())
    }

    fn moov(&mut self, moov: &Atom) -> Result<(), Refused> {
        self.children(moov.body, moov.end, |w, a| match &a.kind {
            b"trak" => w.trak(a),
            b"udta" => w.children(a.body, a.end, |w, a| match &a.kind {
                b"meta" => w.meta(a),
                _ => Ok(()),
            }),
            b"mvex" => Err(Refused),
            _ => Ok(()),
        })
    }

    fn trak(&mut self, trak: &Atom) -> Result<(), Refused> {
        self.children(trak.body, trak.end, |w, a| match &a.kind {
            b"edts" => w.children(a.body, a.end, |w, a| match &a.kind {
                b"elst" => w.elst(a),
                _ => Ok(()),
            }),
            b"mdia" => w.children(a.body, a.end, |w, a| match &a.kind {
                b"hdlr" => small(a, 24),
                b"minf" => w.children(a.body, a.end, |w, a| match &a.kind {
                    b"stbl" => w.stbl(a),
                    _ => Ok(()),
                }),
                _ => Ok(()),
            }),
            _ => Ok(()),
        })
    }

    fn elst(&mut self, a: &Atom) -> Result<(), Refused> {
        if a.len() < 8 {
            return Err(Refused);
        }
        let entry = match self.u32_at(a.body)? >> 24 {
            0 => 12,
            1 => 20,
            _ => return Err(Refused),
        };
        self.table(a, 8, entry, MP4_EDITS_MAX).map(|_| ())
    }

    // A counted table: `skip` bytes of header with the count in their last four, then `count`
    // entries of `entry` bytes that must fit in the atom.
    fn table(&mut self, a: &Atom, skip: u64, entry: u64, max: u32) -> Result<u32, Refused> {
        if a.len() < skip {
            return Err(Refused);
        }
        let count = self.u32_at(a.body + skip - 4)?;
        if count > max || count as u64 * entry > a.len() - skip {
            return Err(Refused);
        }
        Ok(count)
    }

    fn stbl(&mut self, stbl: &Atom) -> Result<(), Refused> {
        self.children(stbl.body, stbl.end, |w, a| match &a.kind {
            b"stsd" => w.stsd(a),
            b"stts" => w.table(a, 8, 8, MP4_ENTRIES_MAX).map(|_| ()),
            b"stsc" => w.table(a, 8, 12, MP4_ENTRIES_MAX).map(|_| ()),
            b"stco" => w.table(a, 8, 4, MP4_ENTRIES_MAX).map(|_| ()),
            b"co64" => w.table(a, 8, 8, MP4_ENTRIES_MAX).map(|_| ()),
            b"stsz" => w.stsz(a),
            _ => Ok(()),
        })
    }

    fn stsz(&mut self, a: &Atom) -> Result<(), Refused> {
        if a.len() < 12 {
            return Err(Refused);
        }
        let size = self.u32_at(a.body + 4)?;
        if size != 0 {
            return if size > MP4_SAMPLE_MAX {
                Err(Refused)
            } else {
                Ok(())
            };
        }
        let count = self.table(a, 12, 4, MP4_ENTRIES_MAX)?;
        // Every sample is read whole at its declared size.
        let mut scratch = [0u8; 4_096];
        let mut left = count as usize * 4;
        let mut pos = a.body + 12;
        while left > 0 {
            let n = left.min(scratch.len());
            self.read_at(pos, &mut scratch[..n])?;
            for s in scratch[..n].as_chunks::<4>().0 {
                if u32::from_be_bytes(*s) > MP4_SAMPLE_MAX {
                    return Err(Refused);
                }
            }
            pos += n as u64;
            left -= n;
        }
        Ok(())
    }

    fn stsd(&mut self, a: &Atom) -> Result<(), Refused> {
        if a.len() < 8 {
            return Err(Refused);
        }
        if self.u32_at(a.body + 4)? != 1 {
            // symphonia plays exactly one sample entry and refuses anything else unread.
            return Ok(());
        }
        let entry = self.atom(a.body + 8, a.end, false)?;
        if AUDIO_ENTRIES.contains(&&entry.kind) {
            self.audio_entry(&entry)?;
        }
        Ok(())
    }

    fn audio_entry(&mut self, e: &Atom) -> Result<(), Refused> {
        if e.len() < 28 {
            return Err(Refused);
        }
        let version = self.u32_at(e.body + 8)? >> 16;
        let fixed = match version {
            0 => 28,
            1 => 44,
            2 => 64,
            _ => return Err(Refused),
        };
        if e.len() < fixed {
            return Err(Refused);
        }
        if version == 2 && self.u32_at(e.body + 60)? > LPCM_FRAMES_MAX {
            return Err(Refused);
        }
        self.children(e.body + fixed, e.end, |w, a| match &a.kind {
            b"esds" => w.esds(a),
            b"alac" => w.alac(a),
            b"dfLa" | b"dOps" => small(a, 0),
            b"wave" => w.children(a.body, a.end, |w, a| match &a.kind {
                b"esds" => w.esds(a),
                _ => Ok(()),
            }),
            _ => Ok(()),
        })
    }

    fn alac(&mut self, a: &Atom) -> Result<(), Refused> {
        small(a, 8)?;
        if self.u32_at(a.body + 4)? > ALAC_FRAME_MAX {
            return Err(Refused);
        }
        Ok(())
    }

    fn esds(&mut self, a: &Atom) -> Result<(), Refused> {
        small(a, 4)?;
        let mut buf = vec![0u8; a.len() as usize];
        self.read_at(a.body, &mut buf)?;
        check_esds(&buf)
    }

    fn meta(&mut self, meta: &Atom) -> Result<(), Refused> {
        if meta.len() < 4 {
            return Err(Refused);
        }
        self.children(meta.body + 4, meta.end, |w, a| match &a.kind {
            b"hdlr" => small(a, 24),
            b"ilst" => w.children(a.body, a.end, |w, item| {
                w.children(item.body, item.end, |_, a| match &a.kind {
                    b"data" if a.len() < 8 || a.len() > MP4_ITEM_MAX => Err(Refused),
                    b"name" | b"mean" => small(a, 4),
                    _ => Ok(()),
                })
            }),
            _ => Ok(()),
        })
    }
}

// A box read whole: at least `min` and at most `MP4_BOX_MAX` bytes of payload.
fn small(a: &Atom, min: u64) -> Result<(), Refused> {
    if a.len() < min || a.len() > MP4_BOX_MAX {
        return Err(Refused);
    }
    Ok(())
}

// symphonia's esds reader, replayed byte for byte over the atom payload. Each nested reader is
// scoped: a read must fit its own scope and every scope around it, while its loop runs on its own
// scope's room alone. `None` is where symphonia's read fails and it stops, allocating nothing more.
struct Esds<'a> {
    d: &'a [u8],
    pos: usize,
}

impl Esds<'_> {
    fn read(&mut self, n: usize, limit: usize) -> Option<usize> {
        if n > limit.saturating_sub(self.pos) {
            return None;
        }
        let at = self.pos;
        self.pos += n;
        Some(at)
    }

    fn byte(&mut self, limit: usize) -> Option<u8> {
        self.read(1, limit).map(|at| self.d[at])
    }

    // A descriptor header: its tag and declared length.
    fn header(&mut self, limit: usize) -> Option<(u8, usize)> {
        let tag = self.byte(limit)?;
        let mut size = 0usize;
        for _ in 0..4 {
            let b = self.byte(limit)?;
            size = (size << 7) | (b & 0x7F) as usize;
            if b & 0x80 == 0 {
                break;
            }
        }
        Some((tag, size))
    }

    // `ignore_bytes` on a scope ending at `scope` inside `limit`.
    fn ignore(&mut self, n: usize, scope: usize, limit: usize) -> Option<()> {
        if n > scope.saturating_sub(self.pos) {
            return None;
        }
        self.read(n, limit).map(|_| ())
    }
}

// The ES descriptor: id and flags, the optional fields, then its children over a scope of
// `len - 3` bytes that starts after the optional fields. Ok(None) where symphonia stops.
fn es_descriptor(e: &mut Esds, len: usize, limit: usize) -> Result<Option<()>, Refused> {
    let Some(at) = e.read(3, limit) else {
        return Ok(None);
    };
    let flags = e.d[at + 2];
    if flags & 0x80 != 0 && e.read(2, limit).is_none() {
        return Ok(None);
    }
    if flags & 0x40 != 0 {
        let Some(url) = e.byte(limit) else {
            return Ok(None);
        };
        if e.ignore(url as usize, limit, limit).is_none() {
            return Ok(None);
        }
    }
    if flags & 0x20 != 0 && e.read(2, limit).is_none() {
        return Ok(None);
    }
    // `len - 3` underflows in symphonia below 3.
    let Some(span) = len.checked_sub(3) else {
        return Err(Refused);
    };
    let scope = e.pos + span;
    let inner = scope.min(limit);
    let (mut config, mut sl) = (false, false);
    while scope.saturating_sub(e.pos) > 2 {
        let Some((tag, n)) = e.header(inner) else {
            return Ok(None);
        };
        match tag {
            0x04 => {
                if decoder_config(e, n, inner)?.is_none() {
                    return Ok(None);
                }
                config = true;
            }
            // symphonia reads one byte of an SL descriptor whatever its length, and goes on from
            // there; anything but 2 is refused.
            0x06 => {
                if e.byte(inner) != Some(2) {
                    return Ok(None);
                }
                sl = true;
            }
            _ => {
                if e.ignore(n, scope, limit).is_none() {
                    return Ok(None);
                }
            }
        }
    }
    if scope > limit || !config || !sl {
        return Ok(None);
    }
    e.pos = e.pos.max(scope);
    Ok(Some(()))
}

// The decoder config descriptor: 13 fixed bytes, then its children over `len - 13` bytes; the
// decoder-specific info among them is allocated at its declared length before it is read.
fn decoder_config(e: &mut Esds, len: usize, limit: usize) -> Result<Option<()>, Refused> {
    if e.read(13, limit).is_none() {
        return Ok(None);
    }
    let Some(span) = len.checked_sub(13) else {
        return Err(Refused);
    };
    let scope = e.pos + span;
    let inner = scope.min(limit);
    while scope.saturating_sub(e.pos) > 2 {
        let Some((tag, n)) = e.header(inner) else {
            return Ok(None);
        };
        if tag == 0x05 {
            if n > inner.saturating_sub(e.pos) {
                return Err(Refused);
            }
            e.pos += n;
        } else if e.ignore(n, scope, limit).is_none() {
            return Ok(None);
        }
    }
    if scope > limit {
        return Ok(None);
    }
    e.pos = e.pos.max(scope);
    Ok(Some(()))
}

// An `esds` payload (version and flags first), read as symphonia reads it. symphonia unwraps the
// ES descriptor, so a payload with none would panic it: refused.
fn check_esds(d: &[u8]) -> Result<(), Refused> {
    if d.len() < 4 {
        return Err(Refused);
    }
    let limit = d.len();
    let mut e = Esds { d, pos: 4 };
    let mut found = false;
    while limit - e.pos > 2 {
        let Some((tag, n)) = e.header(limit) else {
            return Ok(());
        };
        if tag == 0x03 {
            if es_descriptor(&mut e, n, limit)?.is_none() {
                return Ok(());
            }
            found = true;
        } else if e.ignore(n, limit, limit).is_none() {
            return Ok(());
        }
    }
    if !found {
        return Err(Refused);
    }
    Ok(())
}

/// Walks the MP4 at the start of `src`, `len` bytes long, and leaves `src` at the start.
pub(crate) fn check_mp4<R: Read + Seek>(src: &mut R, len: u64) -> Result<(), Refused> {
    let mut walk = Walk { src };
    walk.top(len)?;
    walk.src.seek(SeekFrom::Start(0)).map_err(|_| Refused)?;
    Ok(())
}

#[cfg(test)]
mod tests;
