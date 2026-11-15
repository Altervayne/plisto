/*
 * Reading frames: the two readers, the length-first header check, and the field-by-field payload
 * reader. Nothing here sizes a buffer from a length before the length is checked.
 */

// -- Library Imports --
use std::io::{self, Read};
use std::ops::RangeInclusive;

// -- Local Imports --
use super::*;
use crate::audio::stream::{MIN_CHUNK_FRAMES, SPEC_FLIPS_MAX};
use crate::audio::AudioSpec;

/// Reads the helper's frames in the main process. After any error every later call returns the
/// same error: the stream is out of step and the helper must be stopped.
pub struct HelperReader<R> {
    r: R,
    failed: Option<WireError>,
    flips: SpecFlips,
}

impl<R: Read> HelperReader<R> {
    pub fn new(r: R) -> HelperReader<R> {
        HelperReader {
            r,
            failed: None,
            flips: SpecFlips::default(),
        }
    }

    /// The next frame. `None` is a clean end of stream between frames.
    pub fn read_frame(&mut self) -> Result<Option<HelperFrame>, WireError> {
        if let Some(e) = self.failed {
            return Err(e);
        }
        let read = read_helper(&mut self.r).and_then(|frame| match &frame {
            Some(HelperFrame::Chunk(chunk)) if !self.flips.take(chunk.spec, chunk.frames()) => {
                Err(WireError::SpecFlips)
            }
            _ => Ok(frame),
        });
        if let Err(e) = read {
            self.failed = Some(e);
        }
        read
    }
}

/// Reads the main process's frames in the helper, latching the first error as `HelperReader` does.
pub struct MainReader<R> {
    r: R,
    failed: Option<WireError>,
}

impl<R: Read> MainReader<R> {
    pub fn new(r: R) -> MainReader<R> {
        MainReader { r, failed: None }
    }

    /// The next frame. `None` is a clean end of stream between frames.
    pub fn read_frame(&mut self) -> Result<Option<MainFrame>, WireError> {
        if let Some(e) = self.failed {
            return Err(e);
        }
        let read = read_main(&mut self.r);
        if let Err(e) = read {
            self.failed = Some(e);
        }
        read
    }
}

// Counts spec changes that come with less than `MIN_CHUNK_FRAMES` of audio between them, as the
// decode thread does inside the helper.
#[derive(Default)]
struct SpecFlips {
    spec: Option<AudioSpec>,
    frames: usize,
    flips: usize,
}

impl SpecFlips {
    // False once more than `SPEC_FLIPS_MAX` short runs have come in a row.
    fn take(&mut self, spec: AudioSpec, frames: usize) -> bool {
        if self.spec.is_some_and(|s| s != spec) {
            if self.frames < MIN_CHUNK_FRAMES {
                self.flips += 1;
            } else {
                self.flips = 0;
            }
            self.frames = 0;
        }
        self.spec = Some(spec);
        self.frames += frames;
        self.flips <= SPEC_FLIPS_MAX
    }
}

pub(super) fn read_main<R: Read>(r: &mut R) -> Result<Option<MainFrame>, WireError> {
    let Some((kind, mut p)) = read_header(r, main_bounds)? else {
        return Ok(None);
    };
    let frame = match kind {
        OPEN => MainFrame::Open {
            hint: read_hint(&mut p)?,
            seekable: p.flag("seekable")?,
            guarded: p.flag("guarded")?,
            len: if p.flag("len")? { Some(p.u64()?) } else { None },
        },
        DATA => {
            let len = p.left as usize;
            MainFrame::Data(p.bytes(len)?)
        }
        EOF => MainFrame::Eof,
        BROKEN => MainFrame::Broken,
        SEEK => MainFrame::Seek {
            secs: check_secs(p.f64()?)?,
            generation: p.u64()?,
        },
        SEEKS_CLOSED => MainFrame::SeeksClosed {
            pending: if p.flag("pending")? {
                Some((check_secs(p.f64()?)?, p.u64()?))
            } else {
                None
            },
        },
        _ => return Err(WireError::UnknownKind(kind)),
    };
    p.finish()?;
    Ok(Some(frame))
}

pub(super) fn read_helper<R: Read>(r: &mut R) -> Result<Option<HelperFrame>, WireError> {
    let Some((kind, mut p)) = read_header(r, helper_bounds)? else {
        return Ok(None);
    };
    let frame = match kind {
        READY => HelperFrame::Ready,
        OPENED => HelperFrame::Opened {
            rate: check_rate(p.u32()?)?,
            channels: check_channels(p.u16()?)?,
            duration_secs: if p.flag("duration")? {
                Some(check_duration(p.f64()?)?)
            } else {
                None
            },
        },
        READ => HelperFrame::Read {
            source: match p.tag("source", 2)? {
                0 => ReadSource::Audio,
                _ => ReadSource::Image,
            },
            pos: p.u64()?,
            max: check_read_max(p.u32()?)?,
        },
        CHUNK => {
            let rate = p.u32()?;
            let channels = p.u16()?;
            let frames = p.u32()?;
            check_spec(rate, channels, frames)?;
            // Both factors are checked, so the product is at most 131,072 samples.
            let count = frames as usize * channels as usize;
            if p.left as usize != count * 4 {
                return Err(WireError::ChunkSize {
                    expected: count * 4,
                    got: p.left as usize,
                });
            }
            HelperFrame::Chunk(PcmChunk {
                samples: p.samples(count)?,
                spec: AudioSpec {
                    sample_rate: rate,
                    channels,
                },
            })
        }
        BREAK => HelperFrame::Break(UncheckedSeam(match p.tag("seam", 2)? {
            0 => Seam::Seek(p.u64()?),
            _ => Seam::Chain,
        })),
        SEEKS_OPEN => HelperFrame::SeeksOpen,
        CLOSE_SEEKS => HelperFrame::CloseSeeks,
        END => HelperFrame::End(match p.tag("decode_end", 5)? {
            0 => DecodeEnd::Finished,
            1 => DecodeEnd::SourceBroken,
            2 => DecodeEnd::Corrupt,
            3 => DecodeEnd::Panicked,
            _ => DecodeEnd::Failed(match p.tag("unsupported", 5)? {
                0 => Unsupported::ContentType,
                1 => Unsupported::Playlist,
                2 => Unsupported::Format,
                3 => Unsupported::Codec,
                _ => Unsupported::Seek,
            }),
        }),
        _ => return Err(WireError::UnknownKind(kind)),
    };
    p.finish()?;
    Ok(Some(frame))
}

fn read_hint<R: Read>(p: &mut Payload<'_, R>) -> Result<Option<String>, WireError> {
    if !p.flag("hint")? {
        return Ok(None);
    }
    let len = usize::from(p.u8()?);
    if len > HINT_MAX {
        return Err(WireError::HintTooLong(len));
    }
    String::from_utf8(p.bytes(len)?)
        .map(Some)
        .map_err(|_| WireError::HintNotUtf8)
}

// Reads the kind and length and checks both. Allocates nothing.
fn read_header<R: Read>(
    r: &mut R,
    bounds: fn(u8) -> Option<RangeInclusive<u32>>,
) -> Result<Option<(u8, Payload<'_, R>)>, WireError> {
    let mut head = [0u8; HEADER];
    // A clean end of stream is only possible before a frame's first byte.
    loop {
        match r.read(&mut head[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(WireError::Io(e.kind())),
        }
    }
    read_full(r, &mut head[1..])?;
    let kind = head[0];
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    let Some(legal) = bounds(kind) else {
        return Err(WireError::UnknownKind(kind));
    };
    if len > WIRE_FRAME_MAX {
        return Err(WireError::TooLarge(len));
    }
    if !legal.contains(&len) {
        return Err(WireError::BadLength { kind, len });
    }
    Ok(Some((kind, Payload { r, left: len })))
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> Result<(), WireError> {
    r.read_exact(buf).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => WireError::Torn,
        kind => WireError::Io(kind),
    })
}

/// The rest of one frame's payload, read field by field. A field longer than what is left is
/// refused before it is read.
struct Payload<'a, R> {
    r: &'a mut R,
    left: u32,
}

impl<R: Read> Payload<'_, R> {
    fn fill(&mut self, buf: &mut [u8]) -> Result<(), WireError> {
        if buf.len() > self.left as usize {
            return Err(WireError::Short);
        }
        read_full(self.r, buf)?;
        self.left -= buf.len() as u32;
        Ok(())
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], WireError> {
        let mut buf = [0u8; N];
        self.fill(&mut buf)?;
        Ok(buf)
    }

    fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.array::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16, WireError> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, WireError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, WireError> {
        Ok(u64::from_le_bytes(self.array()?))
    }

    fn f64(&mut self) -> Result<f64, WireError> {
        Ok(f64::from_le_bytes(self.array()?))
    }

    /// A tag byte below `count`.
    fn tag(&mut self, field: &'static str, count: u8) -> Result<u8, WireError> {
        let tag = self.u8()?;
        if tag >= count {
            return Err(WireError::BadTag { field, tag });
        }
        Ok(tag)
    }

    fn flag(&mut self, field: &'static str) -> Result<bool, WireError> {
        Ok(self.tag(field, 2)? == 1)
    }

    fn bytes(&mut self, len: usize) -> Result<Vec<u8>, WireError> {
        if len > self.left as usize {
            return Err(WireError::Short);
        }
        let mut bytes = vec![0u8; len];
        self.fill(&mut bytes)?;
        Ok(bytes)
    }

    /// `count` little-endian f32 samples, sanitised. The caller has checked `count` against `left`.
    fn samples(&mut self, count: usize) -> Result<Vec<f32>, WireError> {
        let mut samples = Vec::with_capacity(count);
        let mut buf = [0u8; 4096];
        while samples.len() < count {
            let len = ((count - samples.len()) * 4).min(buf.len());
            self.fill(&mut buf[..len])?;
            let (words, _) = buf[..len].as_chunks::<4>();
            samples.extend(words.iter().map(|w| sanitize(f32::from_le_bytes(*w))));
        }
        Ok(samples)
    }

    fn finish(self) -> Result<(), WireError> {
        if self.left > 0 {
            return Err(WireError::Trailing(self.left));
        }
        Ok(())
    }
}
