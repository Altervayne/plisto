/*
 * The Ogg/Opus .opus cutter: copy a time range out of an Ogg stream by remuxing whole Opus packets, no
 * decode and no re-encode. It reads the source's OpusHead and OpusTags, copies each onto its own page,
 * then selects the audio packets overlapping the range and rewrites them with fresh granule positions.
 * The result is a valid Opus stream of the source's own packets, so it stays byte-exact and decodable.
 *
 * Opus always decodes at 48 kHz, and the app's analysis drops the OpusHead pre-skip from the front, so
 * the frame range arrives post-priming. Mapping it back to raw packet-cumulative samples adds the
 * pre-skip, keeping the cut aligned with the waveform. Selection is packet-aligned: a packet belongs to
 * the segment its cumulative span overlaps, which snaps the cut to the ~20 ms packet grid.
 */

// -- Library Imports --
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Write};
use std::path::Path;

use ogg::reading::PacketReader;
use ogg::writing::{PacketWriteEndInfo, PacketWriter};

// -- Local Imports --
use super::CutError;

// Audio packets per output page. Opus packets are small, so batching keeps the page count sane without
// growing any page past a few kilobytes.
const PACKETS_PER_PAGE: u64 = 50;

/// Cuts the Opus packets whose cumulative span overlaps `[start_frame, end_frame)` out of the .opus at
/// `source` into a fresh .opus at `out_tmp`. Packets are copied verbatim - no decode, no re-encode - so
/// the cut stays packet-aligned to the ~20 ms grid. The frame range arrives in the analysis's 48 kHz
/// post-priming coordinates and is shifted by the OpusHead pre-skip to match the raw packet clock. A
/// single streaming pass reads, selects, and writes, buffering only the current page and one packet of
/// lookahead so the final audio packet can carry the stream's end flag.
pub fn cut(
    source: &Path,
    start_frame: u64,
    end_frame: u64,
    out_tmp: &Path,
) -> Result<(), CutError> {
    let input = File::open(source).map_err(|_| CutError::Open)?;
    let mut reader = PacketReader::new(BufReader::new(input));

    let output = File::create(out_tmp).map_err(|_| CutError::Open)?;
    let mut writer = PacketWriter::new(BufWriter::new(output));

    // The stream serial and the pre-skip come from OpusHead, always the first packet. They gate the
    // selection window and every written page, so audio before OpusHead is a malformed stream.
    let mut serial = 0u32;
    let mut have_head = false;
    let mut have_tags = false;

    // The selection window in raw packet-cumulative 48 kHz samples, set once OpusHead's pre-skip is
    // known.
    let mut sel_start = 0u64;
    let mut sel_end = 0u64;

    // The cumulative sample position over the audio packets read, the running granule for the packets
    // written (opening at the pre-skip), and the count already flushed for the page batching.
    let mut cum = 0u64;
    let mut out_gran = 0u64;
    let mut written = 0u64;
    // One packet of lookahead: a selected packet is held until the next is selected or the stream ends,
    // so the last one written can be flagged as the stream's end.
    let mut pending: Option<Vec<u8>> = None;

    loop {
        let packet = match reader.read_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(_) => return Err(CutError::Parse),
        };
        let pkt_serial = packet.stream_serial();
        let data = packet.data;

        if data.starts_with(b"OpusHead") {
            // OpusHead: magic(8) + version(1) + channels(1) + pre_skip(2, little-endian), so the
            // pre-skip needs at least twelve bytes.
            if data.len() < 12 {
                return Err(CutError::Parse);
            }
            serial = pkt_serial;
            let pre_skip = u16::from_le_bytes([data[10], data[11]]) as u64;
            sel_start = start_frame + pre_skip;
            sel_end = end_frame + pre_skip;
            out_gran = pre_skip;
            writer
                .write_packet(data, serial, PacketWriteEndInfo::EndPage, 0)
                .map_err(|_| CutError::Open)?;
            have_head = true;
        } else if data.starts_with(b"OpusTags") {
            // The tags packet rides through verbatim, keeping a valid stream and the source's Vorbis
            // comments; the tagging pass overlays per-cut fields afterward.
            writer
                .write_packet(data, serial, PacketWriteEndInfo::EndPage, 0)
                .map_err(|_| CutError::Open)?;
            have_tags = true;
        } else {
            if !have_head {
                return Err(CutError::Parse);
            }
            let n = opus_samples(&data) as u64;
            // A packet is in the cut when its span [cum, cum + n) overlaps the window.
            if cum + n > sel_start && cum < sel_end {
                if let Some(prev) = pending.take() {
                    write_audio_packet(&mut writer, prev, serial, &mut out_gran, &mut written, false)?;
                }
                pending = Some(data);
            }
            cum += n;
        }
    }

    if !have_head || !have_tags {
        return Err(CutError::Parse);
    }
    if let Some(prev) = pending.take() {
        write_audio_packet(&mut writer, prev, serial, &mut out_gran, &mut written, true)?;
    }

    // Flush the buffered tail to disk before returning so the last page reaches the file.
    let mut inner = writer.into_inner();
    inner.flush().map_err(|_| CutError::Open)?;
    Ok(())
}

/// Writes one selected audio packet, advancing the running granule by the packet's own 48 kHz sample
/// count so the output's granule positions stay consistent. Batches packets into pages, forcing a page
/// break every `PACKETS_PER_PAGE`, and flags the final packet as the stream's end.
fn write_audio_packet<W: io::Write>(
    writer: &mut PacketWriter<'_, W>,
    data: Vec<u8>,
    serial: u32,
    out_gran: &mut u64,
    written: &mut u64,
    last: bool,
) -> Result<(), CutError> {
    *out_gran += opus_samples(&data) as u64;
    let info = if last {
        PacketWriteEndInfo::EndStream
    } else if (*written + 1).is_multiple_of(PACKETS_PER_PAGE) {
        PacketWriteEndInfo::EndPage
    } else {
        PacketWriteEndInfo::NormalPacket
    };
    writer
        .write_packet(data, serial, info, *out_gran)
        .map_err(|_| CutError::Open)?;
    *written += 1;
    Ok(())
}

/// Samples at 48 kHz that one Opus packet decodes to, from its TOC byte (RFC 6716 section 3.1). Code 3
/// packets read the frame count from the second byte; a truncated packet counts as one frame.
fn opus_samples(pkt: &[u8]) -> u32 {
    if pkt.is_empty() {
        return 0;
    }
    let toc = pkt[0];
    let config = (toc >> 3) & 0x1f;
    let code = toc & 0x3;
    let frame = frame_size_48k(config);
    let nframes = match code {
        0 => 1,
        1 | 2 => 2,
        // Code 3 reads the frame count from the second byte's low six bits; a truncated packet with no
        // count byte falls through to a single frame.
        3 if pkt.len() >= 2 => (pkt[1] & 0x3f) as u32,
        _ => 1,
    };
    frame * nframes
}

/// One Opus frame's sample count at 48 kHz, by TOC config (0-31): SILK, hybrid, and CELT modes across
/// the 2.5 ms to 60 ms frame durations.
fn frame_size_48k(config: u8) -> u32 {
    match config {
        0 | 4 | 8 => 480,         // SILK NB/MB/WB 10 ms
        1 | 5 | 9 => 960,         // 20 ms
        2 | 6 | 10 => 1920,       // 40 ms
        3 | 7 | 11 => 2880,       // 60 ms
        12 | 14 => 480,           // Hybrid SWB/FB 10 ms
        13 | 15 => 960,           // Hybrid 20 ms
        16 | 20 | 24 | 28 => 120, // CELT 2.5 ms
        17 | 21 | 25 | 29 => 240, // CELT 5 ms
        18 | 22 | 26 | 30 => 480, // CELT 10 ms
        19 | 23 | 27 | 31 => 960, // CELT 20 ms
        _ => 960,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use lofty::prelude::{Accessor, ItemKey, TaggedFileExt};

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
                std::env::temp_dir().join(format!("plisto_opus_{}_{n}_{nanos}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn opus_samples_reads_a_single_frame_packet() {
        // Config 1 (20 ms), code 0: one frame of 960 samples. TOC = (1 << 3) | 0.
        assert_eq!(opus_samples(&[0x08]), 960);
        // Config 3 (60 ms), code 0: one frame of 2880 samples.
        assert_eq!(opus_samples(&[0x18]), 2880);
        // Config 16 (CELT 2.5 ms), code 0: one frame of 120 samples.
        assert_eq!(opus_samples(&[0x80]), 120);
    }

    #[test]
    fn opus_samples_reads_a_two_frame_packet() {
        // Config 1 (20 ms), code 1: two frames of 960 = 1920. TOC = (1 << 3) | 1.
        assert_eq!(opus_samples(&[0x09]), 1920);
    }

    #[test]
    fn opus_samples_reads_the_frame_count_from_a_code_three_packet() {
        // Config 1 (20 ms), code 3: the second byte's low six bits give the frame count. TOC = 0x0B,
        // count 3 -> 960 * 3 = 2880.
        assert_eq!(opus_samples(&[0x0B, 0x03]), 2880);
        // A code 3 packet with no count byte falls back to a single frame.
        assert_eq!(opus_samples(&[0x0B]), 960);
    }

    #[test]
    fn opus_samples_of_an_empty_packet_is_zero() {
        assert_eq!(opus_samples(&[]), 0);
    }

    // The Vorbis-comment OpusTags packet body: the magic, a vendor string, then each "KEY=value"
    // comment, all length-prefixed little-endian. lofty reads these as the stream's tag.
    fn opus_tags(vendor: &str, comments: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"OpusTags");
        v.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        v.extend_from_slice(vendor.as_bytes());
        v.extend_from_slice(&(comments.len() as u32).to_le_bytes());
        for c in comments {
            v.extend_from_slice(&(c.len() as u32).to_le_bytes());
            v.extend_from_slice(c.as_bytes());
        }
        v
    }

    // The OpusHead identification packet: magic, version 1, channel count, pre-skip, 48 kHz input rate,
    // zero gain, and mapping family 0 (no channel table).
    fn opus_head(channels: u8, pre_skip: u16) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"OpusHead");
        v.push(1); // version
        v.push(channels);
        v.extend_from_slice(&pre_skip.to_le_bytes());
        v.extend_from_slice(&48_000u32.to_le_bytes()); // input sample rate
        v.extend_from_slice(&0u16.to_le_bytes()); // output gain
        v.push(0); // mapping family
        v
    }

    // Writes a valid mono .opus holding `packet_count` encoded 20 ms tone packets behind the given head
    // and tags, granules opening at the pre-skip. This is a real Opus stream the app decoder reads and
    // the cutter remuxes, built without any external fixture.
    fn write_opus_source(path: &Path, pre_skip: u16, comments: &[&str], packet_count: usize) {
        use opus_rs::{Application, OpusEncoder};

        let head = opus_head(1, pre_skip);
        let tags = opus_tags("plisto-test", comments);

        // Encode a 440 Hz tone frame by frame at 48 kHz, 20 ms per packet.
        let frame_size = 960usize;
        let mut enc = OpusEncoder::new(48_000, 1, Application::Audio).expect("builds the encoder");
        let mut scratch = vec![0u8; 4000];
        let mut packets: Vec<Vec<u8>> = Vec::with_capacity(packet_count);
        for frame in 0..packet_count {
            let mut input = vec![0.0f32; frame_size];
            for (i, s) in input.iter_mut().enumerate() {
                let n = (frame * frame_size + i) as f32;
                *s = (n * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5;
            }
            let bytes = enc
                .encode(&input, frame_size, &mut scratch)
                .expect("encodes a frame");
            packets.push(scratch[..bytes].to_vec());
        }

        let file = File::create(path).unwrap();
        let mut writer = PacketWriter::new(BufWriter::new(file));
        let serial = 0x504c_4953u32;
        writer
            .write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)
            .unwrap();
        writer
            .write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)
            .unwrap();
        let mut g = pre_skip as u64;
        let last = packets.len().saturating_sub(1);
        for (i, pkt) in packets.into_iter().enumerate() {
            g += frame_size as u64;
            let info = if i == last {
                PacketWriteEndInfo::EndStream
            } else if (i + 1) % 50 == 0 {
                PacketWriteEndInfo::EndPage
            } else {
                PacketWriteEndInfo::NormalPacket
            };
            writer.write_packet(pkt, serial, info, g).unwrap();
        }
        let mut inner = writer.into_inner();
        inner.flush().unwrap();
    }

    // Decodes a file fully through the app's decoder, returning the total per-channel frame count. Zero
    // means nothing decoded, which is the failure the tag round-trip guards against.
    fn decoded_frames(path: &Path) -> usize {
        let Ok(mut d) = crate::audio::Decoder::open(path) else {
            return 0;
        };
        let mut frames = 0usize;
        while let Some(chunk) = d.next_packet() {
            frames += chunk.frames();
        }
        frames
    }

    #[test]
    fn a_short_source_still_cuts_and_decodes() {
        let dir = TempDir::new();
        let source = dir.path.join("in.opus");
        let out = dir.path.join("out.opus");
        // 40 packets of 960 samples = 38_400 frames after a 312-sample pre-skip.
        write_opus_source(&source, 312, &["TITLE=Whole", "ARTIST=Someone"], 40);
        assert!(decoded_frames(&source) > 0, "the synthetic source decodes");

        // A mid-range in analysis (post-priming) coordinates.
        cut(&source, 9_600, 28_800, &out).expect("cuts the opus");
        let frames = decoded_frames(&out);
        assert!(frames > 0, "the cut decodes to audio");
        // The cut spans about 0.4 s; allow the packet-grid slack around it.
        assert!(
            (14_000..=24_000).contains(&frames),
            "the cut is about the requested length, got {frames} frames"
        );
    }

    #[test]
    fn a_source_without_opus_headers_is_a_parse_error() {
        let dir = TempDir::new();
        let source = dir.path.join("junk.opus");
        let out = dir.path.join("out.opus");
        fs::write(&source, b"not an ogg stream at all").unwrap();
        assert_eq!(cut(&source, 0, 1_000, &out), Err(CutError::Parse));
    }

    // Item 5, the real risk: after the remux, the shared tagging pass (copy_tags + retag_split_segment,
    // both lofty) must rewrite the Opus stream's Vorbis comments without corrupting it. This cuts a
    // synthetic source, tags the output the way the splitter does, then confirms the file still decodes
    // and the tags read back.
    #[test]
    fn tags_round_trip_on_a_cut_opus_without_corrupting_it() {
        let dir = TempDir::new();
        let source = dir.path.join("in.opus");
        let out = dir.path.join("out.opus");
        write_opus_source(
            &source,
            312,
            &["TITLE=Source Title", "ARTIST=Source Artist", "ALBUM=Source Album"],
            60,
        );

        cut(&source, 9_600, 38_400, &out).expect("cuts the opus");
        assert!(decoded_frames(&out) > 0, "the cut decodes before tagging");

        // The splitter path: carry the source tag across, then overlay the per-track fields.
        crate::tags::copy_tags(&source, &out).expect("copies the source tag");
        crate::tags::retag_split_segment(&out, Some("Piece Title"), None, 5)
            .expect("overlays the per-track tag");

        // The stream still decodes after lofty rewrote its Vorbis comments.
        assert!(
            decoded_frames(&out) > 0,
            "the cut still decodes after tagging"
        );

        // The overlaid and inherited fields read back.
        let tagged = lofty::read_from_path(&out).expect("reopens the tagged cut");
        let tag = tagged.primary_tag().expect("the cut carries a tag");
        assert_eq!(tag.title().as_deref(), Some("Piece Title"), "title overlaid");
        assert_eq!(
            tag.get_string(ItemKey::TrackNumber),
            Some("5"),
            "track number overlaid"
        );
        assert_eq!(
            tag.artist().as_deref(),
            Some("Source Artist"),
            "a None artist keeps the source's own"
        );
        assert_eq!(
            tag.album().as_deref(),
            Some("Source Album"),
            "the inherited album rides through"
        );
    }
}
