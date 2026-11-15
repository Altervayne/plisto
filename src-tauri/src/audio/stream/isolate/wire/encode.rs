/*
 * Writing frames. Each encoder runs the checks the reader on the other side runs, so a frame that
 * would be refused is refused here and nothing is written.
 */

// -- Library Imports --
use std::io::Write;
use std::ops::RangeInclusive;

// -- Local Imports --
use super::*;

impl MainFrame {
    /// Writes the frame and flushes. A frame that fails validation writes nothing.
    pub fn write(&self, w: &mut impl Write) -> Result<(), WireError> {
        write_all(w, &self.encode()?)
    }

    pub fn encode(&self) -> Result<Vec<u8>, WireError> {
        match self {
            MainFrame::Open {
                hint,
                seekable,
                guarded,
                len,
            } => frame(OPEN, main_bounds, |out| {
                match hint {
                    Some(hint) => {
                        if hint.len() > HINT_MAX {
                            return Err(WireError::HintTooLong(hint.len()));
                        }
                        out.extend([1, hint.len() as u8]);
                        out.extend(hint.as_bytes());
                    }
                    None => out.push(0),
                }
                out.extend([u8::from(*seekable), u8::from(*guarded)]);
                push_option(out, len.map(u64::to_le_bytes));
                Ok(())
            }),
            MainFrame::Data(bytes) => {
                if bytes.is_empty() || bytes.len() > READ_MAX as usize {
                    return Err(WireError::BadLength {
                        kind: DATA,
                        len: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
                    });
                }
                frame(DATA, main_bounds, |out| {
                    out.extend(bytes);
                    Ok(())
                })
            }
            MainFrame::Eof => frame(EOF, main_bounds, |_| Ok(())),
            MainFrame::Broken => frame(BROKEN, main_bounds, |_| Ok(())),
            MainFrame::Seek { secs, generation } => frame(SEEK, main_bounds, |out| {
                out.extend(check_secs(*secs)?.to_le_bytes());
                out.extend(generation.to_le_bytes());
                Ok(())
            }),
            MainFrame::SeeksClosed { pending } => frame(SEEKS_CLOSED, main_bounds, |out| {
                match pending {
                    Some((secs, generation)) => {
                        out.push(1);
                        out.extend(check_secs(*secs)?.to_le_bytes());
                        out.extend(generation.to_le_bytes());
                    }
                    None => out.push(0),
                }
                Ok(())
            }),
        }
    }
}

impl HelperFrame {
    /// Writes the frame and flushes. A frame that fails validation writes nothing.
    pub fn write(&self, w: &mut impl Write) -> Result<(), WireError> {
        write_all(w, &self.encode()?)
    }

    pub fn encode(&self) -> Result<Vec<u8>, WireError> {
        match self {
            HelperFrame::Ready => frame(READY, helper_bounds, |_| Ok(())),
            HelperFrame::Opened {
                rate,
                channels,
                duration_secs,
            } => frame(OPENED, helper_bounds, |out| {
                out.extend(check_rate(*rate)?.to_le_bytes());
                out.extend(check_channels(*channels)?.to_le_bytes());
                let duration = duration_secs.map(check_duration).transpose()?;
                push_option(out, duration.map(f64::to_le_bytes));
                Ok(())
            }),
            HelperFrame::Read { source, pos, max } => frame(READ, helper_bounds, |out| {
                out.push(match source {
                    ReadSource::Audio => 0,
                    ReadSource::Image => 1,
                });
                out.extend(pos.to_le_bytes());
                out.extend(check_read_max(*max)?.to_le_bytes());
                Ok(())
            }),
            HelperFrame::Chunk(chunk) => {
                let channels = check_channels(chunk.spec.channels)?;
                let len = chunk.samples.len();
                if len % channels as usize != 0 {
                    return Err(WireError::ChunkSize {
                        expected: (len - len % channels as usize) * 4,
                        got: len * 4,
                    });
                }
                let frames = u32::try_from(len / channels as usize).unwrap_or(u32::MAX);
                check_spec(chunk.spec.sample_rate, channels, frames)?;
                frame(CHUNK, helper_bounds, |out| {
                    out.reserve(len * 4 + CHUNK_HEAD as usize);
                    out.extend(chunk.spec.sample_rate.to_le_bytes());
                    out.extend(channels.to_le_bytes());
                    out.extend(frames.to_le_bytes());
                    for sample in &chunk.samples {
                        out.extend(sample.to_le_bytes());
                    }
                    Ok(())
                })
            }
            HelperFrame::Break(UncheckedSeam(seam)) => frame(BREAK, helper_bounds, |out| {
                match seam {
                    Seam::Seek(generation) => {
                        out.push(0);
                        out.extend(generation.to_le_bytes());
                    }
                    Seam::Chain => out.push(1),
                }
                Ok(())
            }),
            HelperFrame::SeeksOpen => frame(SEEKS_OPEN, helper_bounds, |_| Ok(())),
            HelperFrame::CloseSeeks => frame(CLOSE_SEEKS, helper_bounds, |_| Ok(())),
            HelperFrame::End(end) => frame(END, helper_bounds, |out| {
                match end {
                    DecodeEnd::Finished => out.push(0),
                    DecodeEnd::SourceBroken => out.push(1),
                    DecodeEnd::Corrupt => out.push(2),
                    DecodeEnd::Panicked => out.push(3),
                    DecodeEnd::Failed(reason) => out.extend([
                        4,
                        match reason {
                            Unsupported::ContentType => 0,
                            Unsupported::Playlist => 1,
                            Unsupported::Format => 2,
                            Unsupported::Codec => 3,
                            Unsupported::Seek => 4,
                        },
                    ]),
                    DecodeEnd::Cancelled | DecodeEnd::ReaderGone => {
                        return Err(WireError::NotOnWire(*end))
                    }
                }
                Ok(())
            }),
        }
    }
}

// A flag byte, then the value when there is one.
fn push_option(out: &mut Vec<u8>, value: Option<[u8; 8]>) {
    match value {
        Some(bytes) => {
            out.push(1);
            out.extend(bytes);
        }
        None => out.push(0),
    }
}

// Builds one frame around the payload `fill` writes, and checks its length as a reader would.
pub(super) fn frame(
    kind: u8,
    bounds: fn(u8) -> Option<RangeInclusive<u32>>,
    fill: impl FnOnce(&mut Vec<u8>) -> Result<(), WireError>,
) -> Result<Vec<u8>, WireError> {
    let mut out = vec![kind, 0, 0, 0, 0];
    fill(&mut out)?;
    let len = u32::try_from(out.len() - HEADER).unwrap_or(u32::MAX);
    if !bounds(kind).is_some_and(|legal| legal.contains(&len)) {
        return Err(WireError::BadLength { kind, len });
    }
    out[1..HEADER].copy_from_slice(&len.to_le_bytes());
    Ok(out)
}

fn write_all(w: &mut impl Write, frame: &[u8]) -> Result<(), WireError> {
    w.write_all(frame)
        .and_then(|()| w.flush())
        .map_err(|e| WireError::Io(e.kind()))
}
