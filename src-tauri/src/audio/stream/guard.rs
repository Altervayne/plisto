/*
 * The header guard: checks the size fields of a WAV or FLAC header as the bytes pass to the
 * demuxer, and refuses the stream before the demuxer sees a size it would allocate from.
 *
 * symphonia sizes a buffer from a header field before checking it against anything: a WAV
 * `LIST`/`INFO` chunk, a FLAC Vorbis comment (and the picture a `METADATA_BLOCK_PICTURE` comment
 * decodes to) or picture field, a WAV `block_align` times the frames of a packet. A remote server
 * chooses those fields, so each one is bounded here first. The guard
 * sits between the byte source and symphonia's read-ahead, so it sees every byte before symphonia
 * parses it. It reads nothing itself and holds only the field it is assembling.
 *
 * It recognizes a stream by its first 12 bytes, as the stream opening does; any other container
 * passes unchecked.
 */

// -- Library Imports --
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use symphonia::core::io::MediaSource;

// -- Local Imports --
use super::comment_check::CommentCheck;
use super::ogg_guard::OggGuard;

/// The largest WAV `LIST`/`INFO` chunk: its tag strings are read whole.
pub const WAV_INFO_MAX: u32 = 1 << 20;

/// The largest WAV `block_align`: 8 channels of 64-bit samples. A packet holds 1,152 blocks.
pub const WAV_BLOCK_ALIGN_MAX: u16 = 64;

/// The largest FLAC seek table block: its points are read into one growing list.
pub const FLAC_SEEKTABLE_MAX: u32 = 1 << 20;

// A u32 inside a FLAC picture block (big-endian), and what follows it: type, MIME length,
// description length, then after four u32, data length.
#[derive(Clone, Copy, Debug)]
enum Inner {
    Type,
    Mime,
    Desc,
    Data,
}

// The field the guard waits for next.
#[derive(Clone, Copy, Debug)]
enum Field {
    // The first 12 bytes: a RIFF/WAVE header or a FLAC marker and first block header.
    Magic,
    WavChunk,
    // A `LIST` chunk's form, and where the chunk after it starts.
    WavListForm { len: u32, after: u64 },
    // `fmt ` bytes 12..14, and where the chunk after it starts.
    WavBlockAlign { after: u64 },
    FlacBlock,
    FlacInner { inner: Inner, end: u64, last: bool },
    // A Vorbis comment block, streamed whole into `HeaderGuard::comment` up to `end`.
    FlacComment { end: u64, last: bool },
}

/// A refused header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Refused;

/// The pure checker, fed the bytes at their absolute positions.
pub(crate) struct HeaderGuard {
    field: Option<Field>,
    at: u64,
    need: usize,
    got: usize,
    buf: [u8; 12],
    comment: Option<CommentCheck>,
}

impl HeaderGuard {
    pub(crate) fn new() -> Self {
        Self {
            field: Some(Field::Magic),
            at: 0,
            need: 12,
            got: 0,
            buf: [0; 12],
            comment: None,
        }
    }

    pub(crate) fn is_done(&self) -> bool {
        self.field.is_none()
    }

    /// Takes `bytes` read at `pos`. Bytes before the next field are skipped; bytes that start
    /// past it mean the field went by unseen, which is refused.
    pub(crate) fn feed(&mut self, mut pos: u64, mut bytes: &[u8]) -> Result<(), Refused> {
        while !bytes.is_empty() {
            let Some(field) = self.field else {
                return Ok(());
            };
            let want = self.at + self.got as u64;
            let end = pos + bytes.len() as u64;
            if end <= want {
                return Ok(());
            }
            if pos > want {
                return Err(Refused);
            }
            bytes = &bytes[(want - pos) as usize..];
            if let Field::FlacComment {
                end: block_end,
                last,
            } = field
            {
                let n = ((block_end - want) as usize).min(bytes.len());
                if let Some(c) = &mut self.comment {
                    c.feed(&bytes[..n]);
                }
                self.got += n;
                bytes = &bytes[n..];
                pos = want + n as u64;
                if pos == block_end {
                    let checked = self.comment.take().map_or(Ok(()), |c| c.finish());
                    checked?;
                    self.got = 0;
                    if last {
                        self.field = None;
                    } else {
                        self.expect(Field::FlacBlock, block_end, 4);
                    }
                }
                continue;
            }
            let n = (self.need - self.got).min(bytes.len());
            self.buf[self.got..self.got + n].copy_from_slice(&bytes[..n]);
            self.got += n;
            bytes = &bytes[n..];
            pos = want + n as u64;
            if self.got == self.need {
                self.got = 0;
                self.next(field)?;
            }
        }
        Ok(())
    }

    /// Takes a seek of the source to `pos`. A seek past the next field skips it unseen.
    pub(crate) fn seeked(&mut self, pos: u64) -> Result<(), Refused> {
        if self.field.is_none() {
            return Ok(());
        }
        if pos > self.at + self.got as u64 {
            return Err(Refused);
        }
        if pos <= self.at {
            self.got = 0;
            if let Some(Field::FlacComment { .. }) = self.field {
                self.comment = Some(CommentCheck::new());
            }
        }
        Ok(())
    }

    fn expect(&mut self, field: Field, at: u64, need: usize) {
        self.field = Some(field);
        self.at = at;
        self.need = need;
    }

    fn le(&self, i: usize) -> u32 {
        u32::from_le_bytes([
            self.buf[i],
            self.buf[i + 1],
            self.buf[i + 2],
            self.buf[i + 3],
        ])
    }

    fn be(&self) -> u32 {
        u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]])
    }

    // Moves past a completed field.
    fn next(&mut self, field: Field) -> Result<(), Refused> {
        let end = self.at + self.need as u64;
        match field {
            Field::Magic => {
                if &self.buf[0..4] == b"RIFF" && &self.buf[8..12] == b"WAVE" {
                    self.expect(Field::WavChunk, end, 8);
                } else if &self.buf[0..4] == b"fLaC" {
                    // The first block header is already in hand.
                    self.buf.copy_within(4..8, 0);
                    self.at = 4;
                    self.need = 4;
                    return self.next(Field::FlacBlock);
                } else {
                    self.field = None;
                }
            }
            Field::WavChunk => {
                let len = self.le(4);
                let after = end + len as u64 + (len & 1) as u64;
                match &self.buf[0..4] {
                    // The audio starts: nothing after it is parsed before playback.
                    b"data" => self.field = None,
                    b"LIST" if len >= 4 => self.expect(Field::WavListForm { len, after }, end, 4),
                    b"fmt " if len >= 14 => {
                        self.expect(Field::WavBlockAlign { after }, end + 12, 2)
                    }
                    _ => self.expect(Field::WavChunk, after, 8),
                }
            }
            Field::WavListForm { len, after } => {
                if &self.buf[0..4] == b"INFO" && len > WAV_INFO_MAX {
                    return Err(Refused);
                }
                self.expect(Field::WavChunk, after, 8);
            }
            Field::WavBlockAlign { after } => {
                if u16::from_le_bytes([self.buf[0], self.buf[1]]) > WAV_BLOCK_ALIGN_MAX {
                    return Err(Refused);
                }
                self.expect(Field::WavChunk, after, 8);
            }
            Field::FlacBlock => {
                let last = self.buf[0] & 0x80 != 0;
                let len = self.be() & 0x00FF_FFFF;
                let block_end = end + len as u64;
                let inner = match self.buf[0] & 0x7F {
                    3 if len > FLAC_SEEKTABLE_MAX => return Err(Refused),
                    4 => {
                        // The comment block streams through a whole-comment check.
                        self.comment = Some(CommentCheck::new());
                        self.expect(
                            Field::FlacComment {
                                end: block_end,
                                last,
                            },
                            end,
                            0,
                        );
                        return Ok(());
                    }
                    6 => Some(Inner::Type),
                    _ => None,
                };
                match inner {
                    Some(inner) => self.inner_at(inner, end, block_end, last)?,
                    None if last => self.field = None,
                    None => self.expect(Field::FlacBlock, block_end, 4),
                }
            }
            Field::FlacInner {
                inner,
                end: block_end,
                last,
            } => {
                let left = block_end - end;
                let value = self.be() as u64;
                let fits = |n: u64| if n <= left { Ok(()) } else { Err(Refused) };
                let next = match inner {
                    Inner::Type => Some((Inner::Mime, end)),
                    Inner::Mime => {
                        fits(value)?;
                        Some((Inner::Desc, end + value))
                    }
                    Inner::Desc => {
                        fits(value)?;
                        Some((Inner::Data, end + value + 16))
                    }
                    Inner::Data => {
                        fits(value)?;
                        None
                    }
                };
                match next {
                    Some((inner, at)) => self.inner_at(inner, at, block_end, last)?,
                    None if last => self.field = None,
                    None => self.expect(Field::FlacBlock, block_end, 4),
                }
            }
            // Streamed in `feed`, never assembled as a field.
            Field::FlacComment { .. } => {}
        }
        Ok(())
    }

    // Expects a u32 at `at` inside a block ending at `end`; one that would not fit is refused.
    fn inner_at(&mut self, inner: Inner, at: u64, end: u64, last: bool) -> Result<(), Refused> {
        if at + 4 > end {
            return Err(Refused);
        }
        self.expect(Field::FlacInner { inner, end, last }, at, 4);
        Ok(())
    }
}

// Which check runs, chosen from the first four bytes.
enum Mode {
    Sniff { head: [u8; 4], got: usize },
    Header(HeaderGuard),
    Ogg(Box<OggGuard>),
}

impl Mode {
    fn feed(&mut self, pos: u64, bytes: &[u8]) -> Result<(), Refused> {
        if let Mode::Sniff { head, got } = self {
            if pos != *got as u64 {
                return Err(Refused);
            }
            let n = (4 - *got).min(bytes.len());
            head[*got..*got + n].copy_from_slice(&bytes[..n]);
            *got += n;
            if *got < 4 {
                return Ok(());
            }
            let head = *head;
            *self = if &head == b"OggS" {
                Mode::Ogg(Box::new(OggGuard::new()))
            } else {
                Mode::Header(HeaderGuard::new())
            };
            self.feed(0, &head)?;
            return self.feed(4, &bytes[n..]);
        }
        match self {
            Mode::Header(g) if !g.is_done() => g.feed(pos, bytes),
            Mode::Ogg(g) => g.feed(pos, bytes),
            _ => Ok(()),
        }
    }

    fn seeked(&mut self, pos: u64) -> Result<(), Refused> {
        match self {
            Mode::Sniff { got, .. } if pos == 0 => {
                *got = 0;
                Ok(())
            }
            Mode::Sniff { .. } => Err(Refused),
            Mode::Header(g) => g.seeked(pos),
            Mode::Ogg(g) => {
                g.seeked(pos);
                Ok(())
            }
        }
    }
}

/// A byte source behind the header checks: `HeaderGuard` for WAV and FLAC, `OggGuard` for Ogg.
/// A refused header reads as an `InvalidData` error and raises `refused`.
pub(crate) struct Guarded<S> {
    inner: S,
    mode: Mode,
    pos: u64,
    refused: Arc<AtomicBool>,
}

impl<S> Guarded<S> {
    pub(crate) fn new(inner: S, refused: Arc<AtomicBool>) -> Self {
        Self {
            inner,
            mode: Mode::Sniff {
                head: [0; 4],
                got: 0,
            },
            pos: 0,
            refused,
        }
    }

    fn refuse(&self) -> io::Error {
        self.refused.store(true, Ordering::Release);
        io::Error::new(io::ErrorKind::InvalidData, "stream header refused")
    }
}

impl<S: Read> Read for Guarded<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.refused.load(Ordering::Acquire) {
            return Err(self.refuse());
        }
        let n = self.inner.read(buf)?;
        if self.mode.feed(self.pos, &buf[..n]).is_err() {
            return Err(self.refuse());
        }
        self.pos += n as u64;
        Ok(n)
    }
}

impl<S: Seek> Seek for Guarded<S> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let to = self.inner.seek(pos)?;
        if self.mode.seeked(to).is_err() {
            return Err(self.refuse());
        }
        self.pos = to;
        Ok(to)
    }
}

impl<S: MediaSource> MediaSource for Guarded<S> {
    fn is_seekable(&self) -> bool {
        self.inner.is_seekable()
    }

    fn byte_len(&self) -> Option<u64> {
        self.inner.byte_len()
    }
}

#[cfg(test)]
mod tests;
