/*
 * The lossless FLAC cutter: copy a frame range out of a FLAC by lifting the source's own
 * reference-encoded frames, no decode and no re-encode. It selects the frames whose start sample
 * lands in the range, concatenates their bytes, and writes a fresh `fLaC` marker and STREAMINFO in
 * front of them. The result is a valid FLAC of the original frames, so it stays bit-exact and
 * decodable. Selection is block-aligned: a frame belongs to the segment its start sample falls in,
 * which is gapless across adjacent segments and snaps the cut to the nearest frame boundary.
 */

// -- Library Imports --
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

// -- Local Imports --
use super::CutError;
use crate::audio::flac_frames::open_flac_frames;
use crate::audio::DecodeError;

/// The span of the frames chosen for a cut, folded as they are selected: the first frame's start
/// sample, the total sample count, and the smallest and largest block sizes seen. Feeds the
/// STREAMINFO the output header carries.
#[derive(Default)]
struct SelectedSpan {
    first_ts: Option<u64>,
    total: u64,
    min_bs: u64,
    max_bs: u64,
    count: u64,
}

impl SelectedSpan {
    /// Folds one selected frame's start sample and block size into the span.
    fn push(&mut self, ts: u64, dur: u64) {
        self.first_ts.get_or_insert(ts);
        self.total += dur;
        if self.count == 0 {
            self.min_bs = dur;
            self.max_bs = dur;
        } else {
            self.min_bs = self.min_bs.min(dur);
            self.max_bs = self.max_bs.max(dur);
        }
        self.count += 1;
    }
}

/// A frame belongs to the cut when its start sample lands in `[start, end)`. Half-open so each frame
/// falls in exactly one segment, which keeps adjacent segments gapless.
fn in_range(ts: u64, start: u64, end: u64) -> bool {
    ts >= start && ts < end
}

/// Cuts frames whose start sample lands in `[start_frame, end_frame)` out of the FLAC at `source`
/// into a fresh FLAC at `out_tmp`. The source's own encoded frames are copied verbatim - no decode,
/// no re-encode - so the cut is bit-exact and block-aligned. A range that selects no frames writes a
/// valid, empty FLAC. Fails on a source that is not a parseable FLAC.
pub fn cut(
    source: &Path,
    start_frame: u64,
    end_frame: u64,
    out_tmp: &Path,
) -> Result<(), CutError> {
    let mut frames = open_flac_frames(source).map_err(map_decode_error)?;
    if frames.channels == 0 || frames.bits == 0 || frames.sample_rate == 0 {
        return Err(CutError::Parse);
    }

    // Gather the selected frames' bytes and the block-size span the header needs. A cut range is
    // bounded, so holding the copied frames in memory is fine.
    let mut span = SelectedSpan::default();
    let mut data: Vec<u8> = Vec::new();
    while let Some(frame) = frames.next_frame() {
        if in_range(frame.start_frame, start_frame, end_frame) {
            span.push(frame.start_frame, frame.frames);
            data.extend_from_slice(&frame.data);
        }
    }

    // An empty selection still writes a valid header; equal block sizes keep it well-formed.
    let (min_bs, max_bs) = if span.count == 0 {
        (16, 16)
    } else {
        (span.min_bs as u16, span.max_bs as u16)
    };
    let streaminfo = build_streaminfo(
        min_bs,
        max_bs,
        frames.sample_rate,
        frames.channels as u32,
        frames.bits,
        span.total,
    );

    write_output(out_tmp, &streaminfo, &data)
}

/// Builds the 34-byte STREAMINFO block body, big-endian, for a frame-copied FLAC. `min_bs`/`max_bs`
/// are the block-size range of the copied frames (FLAC requires a minimum of at least 16); `total` is
/// the sample count. Frame sizes and the MD5 are left unknown (zero), which is valid: the frames are
/// the source's own, so no decoded-audio checksum is computed.
fn build_streaminfo(
    min_bs: u16,
    max_bs: u16,
    rate: u32,
    ch: u32,
    bits: u32,
    total: u64,
) -> [u8; 34] {
    let mut si = [0u8; 34];
    si[0..2].copy_from_slice(&min_bs.max(16).to_be_bytes());
    si[2..4].copy_from_slice(&max_bs.to_be_bytes());
    // min/max frame size (bytes 4..10) stay zero: unknown is valid.
    // Packed: sample_rate(20) | channels-1(3) | bits_per_sample-1(5) | total_samples(36).
    let packed = ((rate as u64) << 44)
        | (((ch as u64 - 1) & 0x7) << 41)
        | (((bits as u64 - 1) & 0x1f) << 36)
        | (total & 0xF_FFFF_FFFF);
    si[10..18].copy_from_slice(&packed.to_be_bytes());
    // md5 (bytes 18..34) stays zero: unknown is valid.
    si
}

/// Writes the frame-copied FLAC: the `fLaC` marker, the STREAMINFO metadata block (its 4-byte header
/// marking it the last block, then the 34-byte body), then the copied frame bytes.
fn write_output(out_tmp: &Path, streaminfo: &[u8; 34], frames: &[u8]) -> Result<(), CutError> {
    let file = File::create(out_tmp).map_err(|_| CutError::Open)?;
    let mut out = BufWriter::new(file);
    out.write_all(b"fLaC").map_err(|_| CutError::Open)?;
    // Last-metadata-block flag + block type 0 (STREAMINFO) + 24-bit length 34.
    out.write_all(&[0x80, 0x00, 0x00, 0x22])
        .map_err(|_| CutError::Open)?;
    out.write_all(streaminfo).map_err(|_| CutError::Open)?;
    out.write_all(frames).map_err(|_| CutError::Open)?;
    out.flush().map_err(|_| CutError::Open)?;
    Ok(())
}

/// Maps a frame-reader open failure to the cut's coarse error: a genuine open/read failure is `Open`,
/// a container that is not a parseable FLAC is `Parse`.
fn map_decode_error(err: DecodeError) -> CutError {
    match err {
        DecodeError::Open => CutError::Open,
        DecodeError::Unsupported | DecodeError::Decode => CutError::Parse,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("plisto_flac_{}_{n}_{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // Folds a list of (ts, dur) frames through the same range predicate the cut uses, so the
    // selection math is testable without a FLAC.
    fn select(frames: &[(u64, u64)], start: u64, end: u64) -> SelectedSpan {
        let mut span = SelectedSpan::default();
        for &(ts, dur) in frames {
            if in_range(ts, start, end) {
                span.push(ts, dur);
            }
        }
        span
    }

    #[test]
    fn streaminfo_packs_the_known_fields() {
        // 4096-sample blocks, 44.1 kHz stereo 16-bit, 100000 total samples: a hand-verified layout.
        let si = build_streaminfo(4096, 4096, 44_100, 2, 16, 100_000);

        let mut expected = [0u8; 34];
        expected[0..2].copy_from_slice(&4096u16.to_be_bytes()); // min block size
        expected[2..4].copy_from_slice(&4096u16.to_be_bytes()); // max block size
        // min/max frame size stay zero (bytes 4..10).
        // Packed rate | channels-1 | bits-1 | total, hand-computed big-endian.
        expected[10..18].copy_from_slice(&[0x0A, 0xC4, 0x42, 0xF0, 0x00, 0x01, 0x86, 0xA0]);
        // md5 stays zero (bytes 18..34).

        assert_eq!(si, expected);
    }

    #[test]
    fn streaminfo_clamps_the_minimum_block_size() {
        // FLAC requires a minimum block size of at least 16; a smaller value is clamped up.
        let si = build_streaminfo(4, 4096, 44_100, 2, 16, 100_000);
        assert_eq!(u16::from_be_bytes([si[0], si[1]]), 16);
        assert_eq!(u16::from_be_bytes([si[2], si[3]]), 4096);
    }

    #[test]
    fn selection_takes_the_frames_that_start_in_range() {
        // Frames start every 4096 samples; the range [4096, 12288) takes the two whose start lands in
        // it, and the block-size span reflects only those.
        let frames = [
            (0u64, 4096u64),
            (4096, 4096),
            (8192, 2048),
            (12288, 4096),
        ];
        let span = select(&frames, 4096, 12288);

        assert_eq!(span.count, 2, "two frames start in range");
        assert_eq!(span.first_ts, Some(4096));
        assert_eq!(span.total, 4096 + 2048);
        assert_eq!(span.min_bs, 2048);
        assert_eq!(span.max_bs, 4096);
    }

    #[test]
    fn selection_is_empty_when_no_frame_starts_in_range() {
        let frames = [(0u64, 4096u64), (4096, 4096)];
        let span = select(&frames, 10_000, 20_000);
        assert_eq!(span.count, 0);
        assert_eq!(span.first_ts, None);
        assert_eq!(span.total, 0);
    }

    #[test]
    fn an_empty_range_writes_a_valid_flac_header() {
        // A range that selects nothing still lands a well-formed, zero-sample FLAC.
        let dir = TempDir::new();
        let out = dir.path.join("empty.flac");
        let si = build_streaminfo(16, 16, 44_100, 2, 16, 0);
        write_output(&out, &si, &[]).unwrap();

        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(&bytes[0..4], b"fLaC");
        assert_eq!(&bytes[4..8], &[0x80, 0x00, 0x00, 0x22]);
        assert_eq!(bytes.len(), 4 + 4 + 34, "marker, block header, streaminfo, no frames");
    }

    // Decodes a file fully to interleaved f32 through the app's decoder, for the conformance check.
    fn decode_all(path: &Path) -> Vec<f32> {
        let mut d = crate::audio::Decoder::open(path).expect("opens for decode");
        let mut pcm = Vec::new();
        while let Some(chunk) = d.next_packet() {
            pcm.extend_from_slice(&chunk.samples);
        }
        pcm
    }

    // A real-file round-trip: cut a mid-range out of the FLAC at PLISTO_TEST_FLAC, then decode both
    // the source and the cut through the app's decoder and assert the cut is bit-exact against the
    // source over the block-aligned range the cut actually spans. Runs only when the env var points
    // at a real FLAC; a plain `cargo test` skips it.
    #[test]
    fn cut_round_trips_a_real_flac_bit_exact() {
        let Ok(src) = std::env::var("PLISTO_TEST_FLAC") else {
            return;
        };
        let source = PathBuf::from(src);

        let mut reader = open_flac_frames(&source).expect("opens the source flac");
        let ch = reader.channels;
        let total_frames = reader.total_frames;
        assert!(total_frames > 0, "source states its length");

        // A mid-range cut, snapped to frame boundaries by selection.
        let start = total_frames / 4;
        let end = total_frames * 3 / 4;
        let mut span = SelectedSpan::default();
        while let Some(frame) = reader.next_frame() {
            if in_range(frame.start_frame, start, end) {
                span.push(frame.start_frame, frame.frames);
            }
        }
        let first_ts = span.first_ts.expect("the mid-range selects frames");

        let dir = TempDir::new();
        let out = dir.path.join("cut.flac");
        cut(&source, start, end, &out).expect("cuts the flac");

        let src_pcm = decode_all(&source);
        let cut_pcm = decode_all(&out);

        let begin = first_ts as usize * ch;
        let len = span.total as usize * ch;
        assert_eq!(cut_pcm.len(), len, "the cut decodes to the selected sample count");
        assert_eq!(
            &cut_pcm[..],
            &src_pcm[begin..begin + len],
            "the cut is bit-exact over the source range"
        );
    }
}
