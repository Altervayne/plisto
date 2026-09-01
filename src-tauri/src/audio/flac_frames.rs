/*
 * The FLAC frame reader: opens a FLAC through symphonia and hands back its own reference-encoded
 * frames, not decoded PCM. symphonia demuxes a FLAC into one packet per frame, so pulling packets
 * yields the raw frame bytes plus each frame's start sample and block size. The splice cutter copies
 * those frames verbatim into a fresh stream, so this is the only place in the splicer that reaches
 * symphonia for raw frames.
 */

// -- Library Imports --
use std::fs::File;
use std::path::Path;

use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

// -- Local Imports --
use super::decode::{map_open_error, DecodeError};

/// One reference-encoded FLAC frame lifted straight from the source: `data` is the raw frame bytes,
/// `start_frame` is the sample index the frame begins at, and `frames` is its block size in samples
/// per channel.
pub struct FlacFrame {
    pub data: Vec<u8>,
    pub start_frame: u64,
    pub frames: u64,
}

/// A pull-based reader over a FLAC's own frames. Built by `open_flac_frames`; drained by `next_frame`
/// until it returns None at end of stream. The rate, channel count, sample depth, and total frame
/// count come from the container up front.
pub struct FlacFrames {
    format: Box<dyn FormatReader>,
    track_id: u32,
    pub sample_rate: u32,
    pub channels: usize,
    pub bits: u32,
    pub total_frames: u64,
}

impl FlacFrames {
    /// The next FLAC frame, or None at clean end of stream. Packets from any other track are skipped,
    /// so only the FLAC track's frames come through.
    pub fn next_frame(&mut self) -> Option<FlacFrame> {
        loop {
            let packet = self.format.next_packet().ok()?;
            if packet.track_id() != self.track_id {
                continue;
            }
            return Some(FlacFrame {
                data: packet.data.to_vec(),
                start_frame: packet.ts(),
                frames: packet.dur(),
            });
        }
    }
}

/// Probes `path` as a FLAC and reads its stream parameters, ready to yield frames. `Unsupported` is a
/// container symphonia does not implement; anything else that fails to open is `Open`.
pub fn open_flac_frames(path: &Path) -> Result<FlacFrames, DecodeError> {
    let file = File::open(path).map_err(|_| DecodeError::Open)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // Seed the probe with the FLAC extension so a raw stream with no container magic still routes.
    let mut hint = Hint::new();
    hint.with_extension("flac");

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(map_open_error)?;

    let format = probed.format;
    let track = format.default_track().ok_or(DecodeError::Open)?;

    let track_id = track.id;
    let params = &track.codec_params;
    let sample_rate = params.sample_rate.unwrap_or(0);
    let channels = params.channels.map(|c| c.count()).unwrap_or(0);
    let bits = params.bits_per_sample.unwrap_or(0);
    let total_frames = params.n_frames.unwrap_or(0);

    Ok(FlacFrames {
        format,
        track_id,
        sample_rate,
        channels,
        bits,
        total_frames,
    })
}
