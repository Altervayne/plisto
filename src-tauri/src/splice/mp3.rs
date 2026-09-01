/*
 * The MP3 cutter: copy a frame range out of an MP3 by lifting whole Layer III frames, no decode and no
 * re-encode. A pure byte scanner walks the frame headers into a frame table, the frames whose decoded
 * start lands in the range are concatenated, and a fresh Xing/Info header frame is written in front so
 * players report the cut's own duration and can seek it. The source's own header frame is dropped.
 *
 * Frames carry raw sample counts from the file's first frame, but the app's waveform decodes through
 * symphonia, which strips the encoder's priming samples. The cut range arrives in those decoded
 * coordinates, so the table maps each frame's raw start into decoded space by subtracting the encoder
 * delay before selecting. Selection is frame-aligned: a frame belongs to the segment its decoded start
 * falls in, gapless across adjacent segments, the same rule the FLAC cutter uses.
 */

// -- Library Imports --
use std::fs;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

// -- Local Imports --
use super::CutError;

// Layer III bitrates in kbps, indexed by the header's 4-bit field. Index 0 is free-format and 15 is
// invalid, both unsupported here.
const BR_V1: [u32; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
]; // MPEG-1 Layer III
const BR_V2: [u32; 16] = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
]; // MPEG-2 / 2.5 Layer III

// Widest resync scan when a non-frame byte run breaks the walk (a trailing ID3v1/APE tag or junk).
const RESYNC_WINDOW: usize = 4096;
// Ceiling on resyncs so a corrupt stream cannot spin the scan.
const MAX_RESYNC: u32 = 32;

/// One Layer III frame located in the source: its byte offset and length, and the raw sample index it
/// begins at counting from the file's first frame.
struct Mp3Frame {
    offset: usize,
    len: usize,
    raw_ts: u64,
}

/// The Xing/Info header a LAME-style encoder writes in the first frame: whether it is VBR (`Xing`) or
/// CBR (`Info`), and the encoder delay symphonia strips from the decoded stream.
struct FirstFrameTag {
    is_vbr: bool,
    encoder_delay: u64,
}

/// The byte offset of the first audio frame, skipping a leading ID3v2 tag when present. The tag size is
/// syncsafe (seven bits per byte); a footer adds ten more bytes.
fn audio_start(b: &[u8]) -> usize {
    if b.len() >= 10 && &b[0..3] == b"ID3" {
        let size = ((b[6] as usize) << 21)
            | ((b[7] as usize) << 14)
            | ((b[8] as usize) << 7)
            | (b[9] as usize);
        let footer = if b[5] & 0x10 != 0 { 10 } else { 0 };
        return 10 + size + footer;
    }
    0
}

/// Parses a Layer III frame header at `p`, returning the frame length in bytes, the samples per frame,
/// and the sample rate. None for anything that is not a supported Layer III header: a bad sync, a
/// reserved version, a non-III layer, or a free-format/invalid bitrate or reserved sample rate.
fn parse_header(b: &[u8], p: usize) -> Option<(usize, u64, u32)> {
    if p + 4 > b.len() || b[p] != 0xFF || (b[p + 1] & 0xE0) != 0xE0 {
        return None;
    }
    let ver = (b[p + 1] >> 3) & 0x3; // 0=2.5, 1=reserved, 2=2, 3=1
    let layer = (b[p + 1] >> 1) & 0x3; // 1 = Layer III
    if ver == 1 || layer != 1 {
        return None;
    }
    let br_idx = ((b[p + 2] >> 4) & 0xF) as usize;
    let sr_idx = ((b[p + 2] >> 2) & 0x3) as usize;
    let pad = ((b[p + 2] >> 1) & 0x1) as usize;
    if br_idx == 0 || br_idx == 15 || sr_idx == 3 {
        return None;
    }
    let (bitrate, is_v1) = if ver == 3 {
        (BR_V1[br_idx], true)
    } else {
        (BR_V2[br_idx], false)
    };
    let sr = match (ver, sr_idx) {
        (3, 0) => 44100,
        (3, 1) => 48000,
        (3, 2) => 32000,
        (2, 0) => 22050,
        (2, 1) => 24000,
        (2, 2) => 16000,
        (0, 0) => 11025,
        (0, 1) => 12000,
        (0, 2) => 8000,
        _ => return None,
    };
    let bitrate = bitrate * 1000;
    let (len, spf) = if is_v1 {
        (144 * bitrate as usize / sr as usize + pad, 1152u64)
    } else {
        (72 * bitrate as usize / sr as usize + pad, 576u64)
    };
    if len < 4 {
        return None;
    }
    Some((len, spf, sr))
}

/// Walks the frames from the first audio byte into a table of offsets and raw sample positions.
/// Advances by each frame's length; on a byte run that is not a frame header it does a bounded resync
/// to step over a trailing tag or junk, and stops once no header is found or the resync ceiling is hit.
fn scan_frames(b: &[u8]) -> Vec<Mp3Frame> {
    let mut frames = Vec::new();
    let mut p = audio_start(b);
    let mut raw_ts = 0u64;
    let mut resyncs = 0u32;

    while p + 4 <= b.len() {
        match parse_header(b, p) {
            Some((len, spf, _)) => {
                // A final frame the file cuts short cannot be copied whole, so stop before it.
                if p + len > b.len() {
                    break;
                }
                frames.push(Mp3Frame {
                    offset: p,
                    len,
                    raw_ts,
                });
                raw_ts += spf;
                p += len;
            }
            None => {
                if resyncs >= MAX_RESYNC {
                    break;
                }
                resyncs += 1;
                match resync(b, p) {
                    Some(next) => p = next,
                    None => break,
                }
            }
        }
    }
    frames
}

/// The next valid frame header at or after `from + 1`, within the resync window. A candidate is
/// accepted only when the frame after it also syncs, which rejects a false 0xFF 0xEx pair inside audio
/// data. None when the window holds no confirmable header.
fn resync(b: &[u8], from: usize) -> Option<usize> {
    let limit = (from + RESYNC_WINDOW).min(b.len().saturating_sub(1));
    let mut q = from + 1;
    while q < limit {
        if b[q] == 0xFF && (b[q + 1] & 0xE0) == 0xE0 {
            if let Some((len, _, _)) = parse_header(b, q) {
                let next = q + len;
                if next + 1 >= b.len() || (b[next] == 0xFF && (b[next + 1] & 0xE0) == 0xE0) {
                    return Some(q);
                }
            }
        }
        q += 1;
    }
    None
}

/// The first byte offset of `needle` in `hay`, or None.
fn find_magic(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// Reads the Xing/Info tag from the first frame's bytes when it carries one. The encoder delay comes
/// from the LAME extension, twelve big-endian bits twenty-one bytes into the `LAME` tag; a Xing header
/// with no LAME extension reports a zero delay. None when the frame carries no Xing/Info tag at all.
fn read_first_frame_tag(frame: &[u8]) -> Option<FirstFrameTag> {
    let magic = find_magic(frame, b"Xing").or_else(|| find_magic(frame, b"Info"))?;
    let is_vbr = &frame[magic..magic + 4] == b"Xing";
    let encoder_delay = find_magic(frame, b"LAME")
        .and_then(|lame| {
            let d = lame + 21;
            (d + 1 < frame.len())
                .then(|| ((frame[d] as u64) << 4) | ((frame[d + 1] as u64) >> 4))
        })
        .unwrap_or(0);
    Some(FirstFrameTag {
        is_vbr,
        encoder_delay,
    })
}

/// The indices of the frames whose decoded start lands in `[start, end)`. `skip_first` drops the source
/// header frame, which is not audio. The decoded start maps each frame's raw sample position into the
/// waveform's coordinates by subtracting the encoder delay, half-open so each frame falls in one
/// segment and adjacent segments stay gapless.
fn selected_indices(
    raw_ts: &[u64],
    skip_first: bool,
    encoder_delay: u64,
    start: u64,
    end: u64,
) -> Vec<usize> {
    raw_ts
        .iter()
        .enumerate()
        .filter_map(|(i, &ts)| {
            if skip_first && i == 0 {
                return None;
            }
            let decoded = ts.saturating_sub(encoder_delay);
            (decoded >= start && decoded < end).then_some(i)
        })
        .collect()
}

/// The side-info size in bytes for a Layer III frame, by version and channel mode. It sits between the
/// header and the Xing/Info payload.
fn side_info_len(is_v1: bool, mono: bool) -> usize {
    match (is_v1, mono) {
        (true, true) => 17,
        (true, false) => 32,
        (false, true) => 9,
        (false, false) => 17,
    }
}

/// Builds a fresh Xing/Info header frame from the stream's own frame header, carrying the output's
/// frame count and byte count so a player reads the cut's duration and can seek it. The frame reuses
/// the source header's version, rate, and channel mode, forces the no-CRC bit so the side info follows
/// the header directly, zeroes the side info, and writes the `Xing`/`Info` magic with a frames+bytes
/// flag word. None when the header does not parse or the frame is too small to hold the tag.
fn build_xing_frame(
    mut header: [u8; 4],
    is_vbr: bool,
    frame_count: u32,
    byte_count: u32,
) -> Option<Vec<u8>> {
    // No CRC: the fresh frame carries no checksum, so the side info begins right after the header.
    header[1] |= 0x01;
    let (len, _, _) = parse_header(&header, 0)?;
    let is_v1 = ((header[1] >> 3) & 0x3) == 3;
    let mono = ((header[3] >> 6) & 0x3) == 3;
    let magic_off = 4 + side_info_len(is_v1, mono);
    if magic_off + 16 > len {
        return None;
    }

    let mut frame = vec![0u8; len];
    frame[0..4].copy_from_slice(&header);
    let magic: &[u8; 4] = if is_vbr { b"Xing" } else { b"Info" };
    frame[magic_off..magic_off + 4].copy_from_slice(magic);
    // Flags: frame count and byte count present, TOC and quality omitted.
    frame[magic_off + 4..magic_off + 8].copy_from_slice(&0x0000_0003u32.to_be_bytes());
    frame[magic_off + 8..magic_off + 12].copy_from_slice(&frame_count.to_be_bytes());
    frame[magic_off + 12..magic_off + 16].copy_from_slice(&byte_count.to_be_bytes());
    Some(frame)
}

/// Cuts frames whose decoded start lands in `[start_frame, end_frame)` out of the MP3 at `source` into
/// a fresh MP3 at `out_tmp`. The source's own Layer III frames are copied verbatim - no decode, no
/// re-encode - behind a fresh Xing/Info header, so the cut stays frame-aligned and gapless. A range
/// that selects no frames writes a valid header-only file. Fails on a source that holds no frames.
pub fn cut(
    source: &Path,
    start_frame: u64,
    end_frame: u64,
    out_tmp: &Path,
) -> Result<(), CutError> {
    let bytes = fs::read(source).map_err(|_| CutError::Open)?;
    let frames = scan_frames(&bytes);
    if frames.is_empty() {
        return Err(CutError::Parse);
    }

    // A leading Xing/Info frame is a header, not audio: read the encoder delay from it and keep it out
    // of the copied range. A stream without one is audio from the first frame.
    let head = &bytes[frames[0].offset..frames[0].offset + frames[0].len];
    let tag = read_first_frame_tag(head);
    let has_header = tag.is_some();
    let encoder_delay = tag.as_ref().map(|t| t.encoder_delay).unwrap_or(0);
    let is_vbr = tag.as_ref().map(|t| t.is_vbr).unwrap_or(false);

    let raw_ts: Vec<u64> = frames.iter().map(|f| f.raw_ts).collect();
    let picked = selected_indices(&raw_ts, has_header, encoder_delay, start_frame, end_frame);

    // A cut range is bounded, so holding the copied frames in memory is fine.
    let mut data = Vec::new();
    for &i in &picked {
        let f = &frames[i];
        data.extend_from_slice(&bytes[f.offset..f.offset + f.len]);
    }

    // The fresh header frame reuses the stream's own frame header, so its length is known before the
    // byte count it carries.
    let o = frames[0].offset;
    let template = [bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]];
    let mut probe = template;
    probe[1] |= 0x01;
    let (xing_len, _, _) = parse_header(&probe, 0).ok_or(CutError::Parse)?;
    let byte_count = (xing_len + data.len()) as u32;
    let xing = build_xing_frame(template, is_vbr, picked.len() as u32, byte_count)
        .ok_or(CutError::Parse)?;

    write_output(out_tmp, &xing, &data)
}

/// Streams the fresh header frame then the copied frame bytes to `out_tmp`.
fn write_output(out_tmp: &Path, xing: &[u8], data: &[u8]) -> Result<(), CutError> {
    let file = File::create(out_tmp).map_err(|_| CutError::Open)?;
    let mut out = BufWriter::new(file);
    out.write_all(xing).map_err(|_| CutError::Open)?;
    out.write_all(data).map_err(|_| CutError::Open)?;
    out.flush().map_err(|_| CutError::Open)?;
    Ok(())
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
            let path =
                std::env::temp_dir().join(format!("plisto_mp3_{}_{n}_{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn parses_an_mpeg1_layer3_header() {
        // 0xFF 0xFB: MPEG-1 Layer III, no CRC. 0x90: 128 kbps, 44.1 kHz, no padding.
        let header = [0xFF, 0xFB, 0x90, 0x00];
        assert_eq!(parse_header(&header, 0), Some((417, 1152, 44_100)));
    }

    #[test]
    fn parses_an_mpeg2_layer3_header() {
        // 0xFF 0xF3: MPEG-2 Layer III, no CRC. 0x50: 40 kbps, 22.05 kHz, no padding.
        let header = [0xFF, 0xF3, 0x50, 0x00];
        assert_eq!(parse_header(&header, 0), Some((130, 576, 22_050)));
    }

    #[test]
    fn rejects_a_non_layer3_header() {
        // Layer bits 10 mark Layer II, which this cutter does not handle.
        let header = [0xFF, 0xFD, 0x90, 0x00];
        assert_eq!(parse_header(&header, 0), None);
        // A broken sync is refused too.
        assert_eq!(parse_header(&[0xFF, 0x1B, 0x90, 0x00], 0), None);
    }

    #[test]
    fn audio_start_skips_an_id3v2_tag() {
        // ID3v2 with a syncsafe size of 100 and no footer: audio begins ten header bytes plus the tag.
        let mut b = vec![0u8; 200];
        b[0..3].copy_from_slice(b"ID3");
        b[3] = 4; // version major
        b[4] = 0; // version minor
        b[5] = 0; // flags, no footer
        b[6] = 0;
        b[7] = 0;
        b[8] = 0;
        b[9] = 100; // syncsafe size 100
        assert_eq!(audio_start(&b), 110);

        // The footer flag adds ten more bytes.
        b[5] = 0x10;
        assert_eq!(audio_start(&b), 120);

        // No tag means audio from byte zero.
        assert_eq!(audio_start(b"\xFF\xFB\x90\x00"), 0);
    }

    #[test]
    fn selection_takes_frames_whose_decoded_start_is_in_range() {
        // Frame 0 is the header frame at raw 0; the rest are audio at 1152-sample steps. With a
        // 1152-sample encoder delay, decoded starts are 0, 0, 1152, 2304, 3456 ...
        let raw_ts = [0u64, 1152, 2304, 3456, 4608, 5760];
        let picked = selected_indices(&raw_ts, true, 1152, 1152, 3456);

        // Decoded starts 1152 and 2304 land in [1152, 3456); the header frame is dropped.
        assert_eq!(picked, vec![2, 3]);
    }

    #[test]
    fn selection_drops_the_header_frame_at_the_start() {
        // The header frame's decoded start is zero, so a range from zero must still not select it.
        let raw_ts = [0u64, 1152, 2304];
        let picked = selected_indices(&raw_ts, true, 1152, 0, 10_000);
        assert_eq!(picked, vec![1, 2]);
    }

    #[test]
    fn selection_is_empty_when_no_frame_starts_in_range() {
        let raw_ts = [0u64, 1152, 2304];
        let picked = selected_indices(&raw_ts, true, 1152, 50_000, 60_000);
        assert!(picked.is_empty());
    }

    #[test]
    fn reads_the_encoder_delay_from_a_lame_tag() {
        // A synthetic first frame: header, zeroed side info, an Info magic, then a LAME tag whose delay
        // field twenty-one bytes in encodes 576.
        let mut frame = vec![0u8; 417];
        frame[0..4].copy_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        let magic_off = 4 + 32; // MPEG-1 stereo side info
        frame[magic_off..magic_off + 4].copy_from_slice(b"Info");
        let lame = magic_off + 40;
        frame[lame..lame + 4].copy_from_slice(b"LAME");
        // delay 576 = 0x240: byte 21 holds the top eight bits, byte 22 the low four in its high nibble.
        frame[lame + 21] = 0x24;
        frame[lame + 22] = 0x00;

        let tag = read_first_frame_tag(&frame).expect("the frame carries an Info tag");
        assert!(!tag.is_vbr, "Info marks a CBR stream");
        assert_eq!(tag.encoder_delay, 576);
    }

    #[test]
    fn a_frame_without_a_xing_tag_reads_as_no_tag() {
        let mut frame = vec![0u8; 417];
        frame[0..4].copy_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        assert!(read_first_frame_tag(&frame).is_none());
    }

    #[test]
    fn builds_a_valid_xing_header_frame() {
        // The template is an MPEG-1 stereo 128 kbps 44.1 kHz frame; the magic and counts land after the
        // header and side info.
        let frame = build_xing_frame([0xFF, 0xFB, 0x90, 0x00], false, 1_000, 500_000)
            .expect("the frame holds the tag");

        // The frame is a valid Layer III frame of the header's own length.
        assert_eq!(parse_header(&frame, 0), Some((417, 1152, 44_100)));

        let magic_off = 4 + 32;
        assert_eq!(&frame[magic_off..magic_off + 4], b"Info");
        assert_eq!(
            u32::from_be_bytes(frame[magic_off + 4..magic_off + 8].try_into().unwrap()),
            0x0000_0003,
            "frames and bytes flags are set"
        );
        assert_eq!(
            u32::from_be_bytes(frame[magic_off + 8..magic_off + 12].try_into().unwrap()),
            1_000,
            "frame count lands after the flags"
        );
        assert_eq!(
            u32::from_be_bytes(frame[magic_off + 12..magic_off + 16].try_into().unwrap()),
            500_000,
            "byte count lands after the frame count"
        );
    }

    #[test]
    fn a_vbr_stream_gets_a_xing_magic() {
        let frame = build_xing_frame([0xFF, 0xFB, 0x90, 0x00], true, 1, 400).unwrap();
        let magic_off = 4 + 32;
        assert_eq!(&frame[magic_off..magic_off + 4], b"Xing");
    }

    #[test]
    fn a_source_with_no_frames_is_a_parse_error() {
        let dir = TempDir::new();
        let source = dir.path.join("junk.mp3");
        let out = dir.path.join("out.mp3");
        std::fs::write(&source, b"not an mp3 at all, no sync anywhere").unwrap();
        assert_eq!(cut(&source, 0, 10, &out), Err(CutError::Parse));
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

    // A real-file round-trip: cut a mid-range out of the MP3 at PLISTO_TEST_MP3, decode both the source
    // and the cut through the app's decoder, and assert a bit-exact run exists once the constant offset
    // is found. The bit reservoir makes the first frames after a mid-stream cut decode without their
    // history, so a few frames are skipped before comparing, and the encoder delay plus frame snapping
    // leave a small offset the search resolves. Runs only when the env var points at a real MP3.
    #[test]
    fn cut_round_trips_a_real_mp3_after_alignment() {
        let Ok(src) = std::env::var("PLISTO_TEST_MP3") else {
            return;
        };
        let source = PathBuf::from(src);

        let probe = crate::audio::Decoder::open(&source).expect("opens the source mp3");
        let ch = probe.spec().channels as usize;
        let total = probe.total_frames().expect("source states its length");
        assert!(ch > 0 && total > 0, "source has channels and a length");

        let start = total / 4;
        let end = total * 3 / 4;

        let dir = TempDir::new();
        let out = dir.path.join("cut.mp3");
        cut(&source, start, end, &out).expect("cuts the mp3");

        let src_pcm = decode_all(&source);
        let cut_pcm = decode_all(&out);

        let skip = 4 * 1152; // per-channel frames dropped for the reservoir warm-up
        let window = 20_000; // per-channel frames compared once aligned
        assert!(
            cut_pcm.len() >= (skip + window) * ch,
            "the cut is long enough to compare"
        );

        let cut_base = skip * ch;
        let mut best_mismatch = usize::MAX;
        for d in -2500i64..=2500 {
            let src_frame = start as i64 + skip as i64 + d;
            if src_frame < 0 {
                continue;
            }
            let src_base = src_frame as usize * ch;
            if src_base + window * ch > src_pcm.len() {
                continue;
            }
            let mut mismatch = 0usize;
            for i in 0..window * ch {
                if (cut_pcm[cut_base + i] - src_pcm[src_base + i]).abs() > 1e-6 {
                    mismatch += 1;
                    if mismatch >= best_mismatch {
                        break;
                    }
                }
            }
            best_mismatch = best_mismatch.min(mismatch);
            if best_mismatch == 0 {
                break;
            }
        }
        assert_eq!(best_mismatch, 0, "a bit-exact alignment offset exists");
    }
}
