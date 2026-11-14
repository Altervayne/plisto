/*
 * Opening a stream's container: the stream path's own replacement for symphonia's probe.
 *
 * symphonia's default probe runs its ID3v2 reader, which allocates each frame at the size the tag
 * claims, and every ID3 tag restarts its marker search, so a server can force a gigabyte buffer or
 * an endless search. Here leading ID3v2 tags are skipped unread, within `ID3_SKIP_MAX` bytes and
 * `ID3_TAGS_MAX` tags, and the container is then chosen from its first bytes: a container must
 * start right there, and only MPEG audio and ADTS may start mid-frame, within `SYNC_SEARCH_MAX`
 * bytes of a frame sync.
 *
 * Everything the opening reads counts against `OPEN_READ_MAX`, the bound on how long a body that
 * never turns into audio is read before it is refused.
 */

// -- Library Imports --
use std::io::{self, Read, Seek, SeekFrom};

use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::{MediaSource, MediaSourceStream, ReadBytes, SeekBuffered};
use symphonia::default::formats::{
    AdtsReader, FlacReader, IsoMp4Reader, MpaReader, OggReader, WavReader,
};

/// The most bytes of leading ID3v2 tags skipped before the audio: room for cover art. Skipped
/// bytes are read through and dropped, never held, and are not counted in `OPEN_READ_MAX`, which
/// starts after them; the two bounds together cap what the opening reads at twice this.
pub const ID3_SKIP_MAX: u64 = 16 << 20;

/// The most leading ID3v2 tags skipped.
pub const ID3_TAGS_MAX: usize = 4;

/// The most bytes read while opening the container, ID3 tags excluded. Room for cover art in a
/// FLAC or MP4 header; a body with no audio in it is refused here.
pub const OPEN_READ_MAX: u64 = 16 << 20;

/// The most bytes searched for an MPEG audio or ADTS frame sync when nothing names the format.
pub const SYNC_SEARCH_MAX: usize = 16 * 1024;

/// Why the leading tags could not be skipped.
#[derive(Debug)]
pub(crate) enum SkipError {
    /// Past `ID3_SKIP_MAX` or `ID3_TAGS_MAX`, or a tag the bytes end inside.
    Refused,
    Io(io::Error),
}

// Reads until `buf` is full or the bytes end; returns how much was read.
fn read_up_to<R: Read>(src: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match src.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

// The size of an ID3v2 tag from its 10-byte header, header and footer included, or None when the
// bytes are not one.
fn id3_size(header: &[u8; 10]) -> Option<u64> {
    if &header[0..3] != b"ID3" || !(2..=4).contains(&header[3]) {
        return None;
    }
    let size = &header[6..10];
    if size.iter().any(|b| b & 0x80 != 0) {
        return None;
    }
    let body = size.iter().fold(0u64, |acc, &b| (acc << 7) | b as u64);
    let footer = if header[5] & 0x10 != 0 { 10 } else { 0 };
    Some(10 + body + footer)
}

/// Skips the leading ID3v2 tags of `src` without keeping them. Returns where the audio starts and,
/// for an unseekable source, the bytes already read past it.
pub(crate) fn skip_id3<R: Read + Seek>(
    src: &mut R,
    seekable: bool,
) -> Result<(u64, Vec<u8>), SkipError> {
    let mut base = 0u64;
    let mut tags = 0;
    let mut scratch = [0u8; 4_096];
    loop {
        let mut header = [0u8; 10];
        let got = read_up_to(src, &mut header).map_err(SkipError::Io)?;
        let size = if got == 10 { id3_size(&header) } else { None };
        let Some(size) = size else {
            if seekable {
                src.seek(SeekFrom::Start(base)).map_err(SkipError::Io)?;
                return Ok((base, Vec::new()));
            }
            return Ok((base, header[..got].to_vec()));
        };
        tags += 1;
        if tags > ID3_TAGS_MAX || base + size > ID3_SKIP_MAX {
            return Err(SkipError::Refused);
        }
        let mut left = size - 10;
        if seekable {
            src.seek(SeekFrom::Start(base + size))
                .map_err(SkipError::Io)?;
            left = 0;
        }
        while left > 0 {
            let want = left.min(scratch.len() as u64) as usize;
            let n = read_up_to(src, &mut scratch[..want]).map_err(SkipError::Io)?;
            if n < want {
                return Err(SkipError::Refused);
            }
            left -= n as u64;
        }
        base += size;
    }
}

/// A source seen from `base` on, with `head` (bytes already read past `base`) served first. An
/// unseekable source carries a head; a seekable one is moved to `base` instead.
pub(crate) struct Trimmed<S> {
    inner: S,
    base: u64,
    head: Vec<u8>,
    head_pos: usize,
}

impl<S> Trimmed<S> {
    pub(crate) fn new(inner: S, base: u64, head: Vec<u8>) -> Self {
        Self {
            inner,
            base,
            head,
            head_pos: 0,
        }
    }

    pub(crate) fn inner(&self) -> &S {
        &self.inner
    }
}

impl<S: Read> Read for Trimmed<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.head_pos < self.head.len() {
            let n = buf.len().min(self.head.len() - self.head_pos);
            buf[..n].copy_from_slice(&self.head[self.head_pos..self.head_pos + n]);
            self.head_pos += n;
            return Ok(n);
        }
        self.inner.read(buf)
    }
}

impl<S: Seek> Seek for Trimmed<S> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let pos = match pos {
            SeekFrom::Start(p) => SeekFrom::Start(self.base + p),
            other => other,
        };
        let at = self.inner.seek(pos)?;
        Ok(at.saturating_sub(self.base))
    }
}

impl<S: MediaSource> MediaSource for Trimmed<S> {
    fn is_seekable(&self) -> bool {
        self.inner.is_seekable()
    }

    fn byte_len(&self) -> Option<u64> {
        self.inner
            .byte_len()
            .map(|len| len.saturating_sub(self.base))
    }
}

/// Why no container reader opened.
#[derive(Debug)]
pub(crate) enum OpenError {
    /// The bytes are no container the stream path plays.
    Unrecognized,
    /// The reader refused or failed on the bytes.
    Reader,
}

/// Opens the container the first bytes of `mss` show. A body that is no container must hold an
/// MPEG audio or ADTS frame sync within `SYNC_SEARCH_MAX` bytes; the sync's layer bits pick the
/// reader. A `hint` naming a container refuses a body that does not start with it.
pub(crate) fn open_reader(
    mut mss: MediaSourceStream,
    hint: Option<&str>,
) -> Result<Box<dyn FormatReader>, OpenError> {
    let mut head = [0u8; 16];
    if ReadBytes::read_buf_exact(&mut mss, &mut head).is_err() {
        return Err(OpenError::Reader);
    }
    SeekBuffered::seek_buffered(&mut mss, 0);
    let opts = FormatOptions::default();
    let reader: symphonia::core::errors::Result<Box<dyn FormatReader>> =
        if head.starts_with(b"RIFF") {
            WavReader::try_new(mss, &opts).map(|r| Box::new(r) as Box<dyn FormatReader>)
        } else if head.starts_with(b"fLaC") {
            FlacReader::try_new(mss, &opts).map(|r| Box::new(r) as Box<dyn FormatReader>)
        } else if head.starts_with(b"OggS") {
            OggReader::try_new(mss, &opts).map(|r| Box::new(r) as Box<dyn FormatReader>)
        } else if &head[4..8] == b"ftyp" {
            // Only a whole body, walked by the MP4 guard first, is opened as MP4.
            if !mss.is_seekable() {
                return Err(OpenError::Unrecognized);
            }
            // The reader expects to stand on the atom type, as symphonia's probe leaves it.
            SeekBuffered::seek_buffered(&mut mss, 4);
            IsoMp4Reader::try_new(mss, &opts).map(|r| Box::new(r) as Box<dyn FormatReader>)
        } else {
            // A hint naming a container whose start is missing is not worth a frame search.
            if matches!(hint, Some("ogg" | "flac" | "wav" | "m4a")) {
                return Err(OpenError::Unrecognized);
            }
            let Some(adts) = find_sync(&mut mss) else {
                return Err(OpenError::Unrecognized);
            };
            if adts {
                AdtsReader::try_new(mss, &opts).map(|r| Box::new(r) as Box<dyn FormatReader>)
            } else {
                MpaReader::try_new(mss, &opts).map(|r| Box::new(r) as Box<dyn FormatReader>)
            }
        };
    reader.map_err(|_| OpenError::Reader)
}

// Looks for the first frame sync within `SYNC_SEARCH_MAX` bytes and leaves the stream where it
// started. Some(true) for ADTS (layer bits 00), Some(false) for MPEG audio.
fn find_sync(mss: &mut MediaSourceStream) -> Option<bool> {
    let start = mss.pos();
    mss.ensure_seekback_buffer(SYNC_SEARCH_MAX + 2);
    let mut prev = 0u8;
    let mut found = None;
    for _ in 0..SYNC_SEARCH_MAX {
        let Ok(byte) = mss.read_byte() else {
            break;
        };
        if prev == 0xFF && byte & 0xE0 == 0xE0 {
            found = Some(byte & 0x06 == 0);
            break;
        }
        prev = byte;
    }
    SeekBuffered::seek_buffered(mss, start);
    found
}

#[cfg(test)]
mod tests;
