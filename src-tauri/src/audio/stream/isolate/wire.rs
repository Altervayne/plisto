/*
 * The binary codec between the main process and the decode helper. A frame is a one-byte kind, a
 * little-endian u32 payload length, then the payload. The length is checked against
 * `WIRE_FRAME_MAX` and against the bounds of its kind before any payload byte is read or any buffer
 * is sized, so a forged length costs nothing. Payload fields are then read one at a time and checked
 * as they arrive: a refusal reads nothing past the field that earned it.
 *
 * The main process treats the helper as possibly compromised. Each field of a helper frame is checked
 * here, `HelperReader` refuses a stream that flips its spec too often, and a seek generation stays an
 * `UncheckedSeam` until it is checked against the stream's control. Encoding runs the same field
 * checks, so the helper never sends what main refuses. The two directions have separate types and
 * disjoint kind bytes: a frame sent the wrong way is an unknown kind. A reader that has failed once
 * fails every later call, since the stream is out of step.
 *
 * What a frame cannot show on its own stays with the caller: the order of frames; whether a `Read`'s
 * source and position are ones the byte source serves, with `pos + max` checked for overflow; and,
 * in the helper, that a `Data` is no longer than the `max` it asked for.
 */

// -- Library Imports --
use std::io;
use std::ops::RangeInclusive;

// -- Local Imports --
use crate::audio::stream::{DecodeEnd, Seam, StreamControl, Unsupported, MAX_CHANNELS, RATES};
use crate::audio::PcmChunk;

// -- Module Declarations --
mod decode;
mod encode;

// -- Re-exports --
pub use decode::{HelperReader, MainReader};

/// The largest payload either side may send.
pub const WIRE_FRAME_MAX: u32 = 1 << 20;

/// The most bytes one `Read` may ask for, and so the largest `Data` payload: one refill of the
/// decoder's read buffer. The helper's byte source must ask in reads no larger.
pub const READ_MAX: u32 = 64 * 1024;

/// The most frames in one `Chunk`. The largest legal chunk is 16,384 frames x 8 channels x 4 bytes
/// = 512 KiB of samples plus a 10-byte head, under `WIRE_FRAME_MAX`. Twice the frames would be
/// exactly 1 MiB of samples, which the head pushes over the cap. The helper splits a larger decoded
/// block into several chunks before sending it.
pub const CHUNK_FRAMES_MAX: u32 = 16_384;

/// The longest format hint `Open` carries, in bytes.
pub const HINT_MAX: usize = 16;

const HEADER: usize = 5;
// Rate u32, channels u16, frames u32.
const CHUNK_HEAD: u32 = 10;
const CHUNK_MAX: u32 = CHUNK_HEAD + CHUNK_FRAMES_MAX * MAX_CHANNELS as u32 * 4;
// Hint flag, hint length, hint, seekable, guarded, length flag, length.
const OPEN_MAX: u32 = 1 + 1 + HINT_MAX as u32 + 1 + 1 + 1 + 8;
const _: () = assert!(CHUNK_MAX <= WIRE_FRAME_MAX);

// Main to helper.
const OPEN: u8 = 0x01;
const DATA: u8 = 0x02;
const EOF: u8 = 0x03;
const BROKEN: u8 = 0x04;
const SEEK: u8 = 0x05;
const SEEKS_CLOSED: u8 = 0x06;

// Helper to main: the high bit set.
const READ: u8 = 0x81;
const CHUNK: u8 = 0x82;
const BREAK: u8 = 0x83;
const SEEKS_OPEN: u8 = 0x84;
const CLOSE_SEEKS: u8 = 0x85;
const END: u8 = 0x86;
const READY: u8 = 0x87;
const OPENED: u8 = 0x88;

/// A frame the main process sends to the helper.
#[derive(Clone, Debug, PartialEq)]
pub enum MainFrame {
    /// The first frame: the media to decode. `guarded` runs the header guards, as for a stream item;
    /// a file the user opened goes without them. `len` is the full body length when it is known.
    Open {
        hint: Option<String>,
        seekable: bool,
        guarded: bool,
        len: Option<u64>,
    },
    /// The answer to a `Read`: 1 to `READ_MAX` bytes from the position it asked for.
    Data(Vec<u8>),
    /// The answer to a `Read` at the end of the body.
    Eof,
    /// The answer to a `Read` when the byte source broke.
    Broken,
    Seek {
        secs: f64,
        generation: u64,
    },
    /// The answer to `CloseSeeks`: the seek that got in before the close, if any.
    SeeksClosed {
        pending: Option<(f64, u64)>,
    },
}

/// Which bytes a `Read` asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadSource {
    Audio,
    /// The image beside the audio, served only to a helper inspecting a file.
    Image,
}

/// A frame the helper sends to the main process.
#[derive(Clone, Debug)]
pub enum HelperFrame {
    /// The first frame, once the helper runs.
    Ready,
    /// The media opened, with the spec it declares and its length when known.
    Opened {
        rate: u32,
        channels: u16,
        duration_secs: Option<f64>,
    },
    Read {
        source: ReadSource,
        pos: u64,
        max: u32,
    },
    /// Non-finite samples are made safe on decode (`sanitize`). A finite sample outside [-1, 1]
    /// passes unchanged, as it does in-process.
    Chunk(PcmChunk),
    Break(UncheckedSeam),
    SeeksOpen,
    CloseSeeks,
    End(DecodeEnd),
}

/// A `Break`'s seam as the helper sent it. Its generation is the helper's word until `check`
/// compares it with the stream's control.
#[derive(Clone, Copy, Debug)]
pub struct UncheckedSeam(Seam);

impl UncheckedSeam {
    pub fn new(seam: Seam) -> UncheckedSeam {
        UncheckedSeam(seam)
    }

    /// The seam, once a seek generation is one main requested and newer than the last answered.
    /// An older one would move `answered` back and reopen a seek already served; zero is never a
    /// seek.
    pub fn check(self, control: &StreamControl) -> Result<Seam, WireError> {
        let Seam::Seek(got) = self.0 else {
            return Ok(self.0);
        };
        let requested = control.requested();
        let answered = control.answered();
        // `answered` is never below zero, so this also refuses zero.
        if got <= answered || got > requested {
            return Err(WireError::BadGeneration {
                got,
                requested,
                answered,
            });
        }
        Ok(self.0)
    }
}

/// Why a frame was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    Io(io::ErrorKind),
    /// The stream ended inside a frame.
    Torn,
    UnknownKind(u8),
    /// A length over `WIRE_FRAME_MAX`.
    TooLarge(u32),
    /// A length its kind can never have.
    BadLength {
        kind: u8,
        len: u32,
    },
    /// The payload ends before a field its earlier fields call for.
    Short,
    /// Bytes left after the last field.
    Trailing(u32),
    /// A tag byte outside its enum or flag.
    BadTag {
        field: &'static str,
        tag: u8,
    },
    HintTooLong(usize),
    HintNotUtf8,
    BadChannels(u16),
    BadRate(u32),
    BadFrames(u32),
    /// Sample bytes other than `frames x channels x 4`.
    ChunkSize {
        expected: usize,
        got: usize,
    },
    BadReadMax(u32),
    /// A seek target that is not finite or is negative.
    BadSeekTarget,
    /// A duration that is not finite or is negative.
    BadDuration,
    /// A seek generation not newer than the last answered or newer than the newest requested.
    BadGeneration {
        got: u64,
        requested: u64,
        answered: u64,
    },
    /// More than `SPEC_FLIPS_MAX` spec changes in a row, each after a short run.
    SpecFlips,
    /// `Cancelled`, `ReaderGone` and `Isolated` are decided by the main process; the helper never
    /// sends them.
    NotOnWire(DecodeEnd),
}

// The legal payload lengths of each main-to-helper kind; None for a kind this direction never has.
fn main_bounds(kind: u8) -> Option<RangeInclusive<u32>> {
    Some(match kind {
        OPEN => 4..=OPEN_MAX,
        DATA => 1..=READ_MAX,
        EOF | BROKEN => 0..=0,
        SEEK => 16..=16,
        SEEKS_CLOSED => 1..=17,
        _ => return None,
    })
}

fn helper_bounds(kind: u8) -> Option<RangeInclusive<u32>> {
    Some(match kind {
        READY | SEEKS_OPEN | CLOSE_SEEKS => 0..=0,
        OPENED => 7..=15,
        READ => 13..=13,
        CHUNK => CHUNK_HEAD + 4..=CHUNK_MAX,
        BREAK => 1..=9,
        END => 1..=2,
        _ => return None,
    })
}

fn check_channels(channels: u16) -> Result<u16, WireError> {
    if !(1..=MAX_CHANNELS).contains(&channels) {
        return Err(WireError::BadChannels(channels));
    }
    Ok(channels)
}

fn check_rate(rate: u32) -> Result<u32, WireError> {
    if !RATES.contains(&rate) {
        return Err(WireError::BadRate(rate));
    }
    Ok(rate)
}

fn check_spec(rate: u32, channels: u16, frames: u32) -> Result<(), WireError> {
    check_channels(channels)?;
    check_rate(rate)?;
    if !(1..=CHUNK_FRAMES_MAX).contains(&frames) {
        return Err(WireError::BadFrames(frames));
    }
    Ok(())
}

fn check_read_max(max: u32) -> Result<u32, WireError> {
    if !(1..=READ_MAX).contains(&max) {
        return Err(WireError::BadReadMax(max));
    }
    Ok(max)
}

fn check_secs(secs: f64) -> Result<f64, WireError> {
    if !secs.is_finite() || secs < 0.0 {
        return Err(WireError::BadSeekTarget);
    }
    Ok(secs)
}

fn check_duration(secs: f64) -> Result<f64, WireError> {
    check_secs(secs).map_err(|_| WireError::BadDuration)
}

/// What a decoded sample becomes. NaN becomes silence and an infinity full scale, so neither reaches
/// the mixer; a finite sample passes bit for bit, as it would from an in-process decoder.
fn sanitize(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else if sample.is_nan() {
        0.0
    } else {
        sample.signum()
    }
}

#[cfg(test)]
mod tests;
