/*
 * The AAC .m4a/.m4b cutter: copy a time range out of an MP4 by frame-copying the AAC samples, no
 * decode and no re-encode. It reads the source sample table, selects the samples whose container
 * start time lands in the range, and writes them into a fresh MP4 through the `mp4` crate's writer.
 *
 * Two things make the output play: only AAC frame-copies (ALAC and other m4a codecs are refused, since
 * the writer cannot carry them), and the finished file's esds SLConfigDescriptor `predefined` byte is
 * rewritten from 0 to 2 - the value symphonia's isomp4 reader requires and the writer omits. The write
 * is flushed to disk before that patch reads the file back, so the last buffered bytes are present.
 */

// -- Library Imports --
use std::fs;
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;

use mp4::{
    AacConfig, MediaConfig, MediaType, Mp4Config, Mp4Reader, Mp4Writer, TrackConfig, TrackType,
};

// -- Local Imports --
use super::CutError;

/// The audio track's frame-copy inputs, lifted from the source header before the sample loop: its id,
/// the AAC config the output track carries, the track timescale, its sample count, and the decoded
/// sample rate the frame range maps through.
struct AudioTrack {
    id: u32,
    aac: AacConfig,
    timescale: u32,
    sample_count: u32,
    sample_rate: u32,
}

/// Cuts the AAC samples whose container start lands in `[start_frame, end_frame)` out of the m4a at
/// `source` into a fresh m4a at `out_tmp`. Samples are copied verbatim - no decode, no re-encode - so
/// the cut stays frame-aligned to the ~23 ms AAC grid. Refuses a non-AAC m4a (ALAC and the rest cannot
/// be frame-copied by the writer) with `UnsupportedFormat`. The frame range arrives in decoded sample
/// coordinates and is mapped into the track timescale before selection.
pub fn cut(
    source: &Path,
    start_frame: u64,
    end_frame: u64,
    out_tmp: &Path,
) -> Result<(), CutError> {
    let file = File::open(source).map_err(|_| CutError::Open)?;
    let size = file.metadata().map_err(|_| CutError::Open)?.len();
    let mut reader =
        Mp4Reader::read_header(BufReader::new(file), size).map_err(|_| CutError::Parse)?;

    let track = pick_audio_track(&reader)?;

    // The frame range is in decoded PCM frames at the audio sample rate; map it into the track
    // timescale. The two are usually equal, so this is near identity, but compute it in general.
    if track.sample_rate == 0 {
        return Err(CutError::Parse);
    }
    let to_ts = |frame: u64| -> u64 {
        (frame as f64 * track.timescale as f64 / track.sample_rate as f64).round() as u64
    };
    let start_ts = to_ts(start_frame);
    let end_ts = to_ts(end_frame);

    write_cut(&mut reader, &track, start_ts, end_ts, out_tmp)?;

    // The writer leaves the esds SLConfigDescriptor predefined byte at 0, which symphonia rejects; set
    // it to 2. Runs on the finished file, so the write must already be flushed.
    patch_sl_predefined(out_tmp)?;
    Ok(())
}

/// Finds the source's AAC audio track and lifts its frame-copy inputs. Returns `UnsupportedFormat` for
/// an audio track that is not AAC (ALAC and others the writer cannot frame-copy), and `Parse` when no
/// audio track is present or its AAC parameters do not read.
fn pick_audio_track<R>(reader: &Mp4Reader<R>) -> Result<AudioTrack, CutError>
where
    R: std::io::Read + std::io::Seek,
{
    for (id, track) in reader.tracks() {
        if track.track_type().ok() != Some(TrackType::Audio) {
            continue;
        }
        if track.media_type().ok() != Some(MediaType::AAC) {
            return Err(CutError::UnsupportedFormat);
        }
        let aac = AacConfig {
            bitrate: track.bitrate(),
            profile: track.audio_profile().map_err(|_| CutError::Parse)?,
            freq_index: track.sample_freq_index().map_err(|_| CutError::Parse)?,
            chan_conf: track.channel_config().map_err(|_| CutError::Parse)?,
        };
        return Ok(AudioTrack {
            id: *id,
            sample_rate: aac.freq_index.freq(),
            aac,
            timescale: track.timescale(),
            sample_count: track.sample_count(),
        });
    }
    Err(CutError::Parse)
}

/// Writes a fresh m4a at `out_tmp` holding the source samples whose start time lands in `[start_ts,
/// end_ts)`, copied byte-for-byte. The writer is dropped before returning so its buffered tail reaches
/// disk before the caller reads the file back to patch it.
fn write_cut<R>(
    reader: &mut Mp4Reader<R>,
    track: &AudioTrack,
    start_ts: u64,
    end_ts: u64,
    out_tmp: &Path,
) -> Result<(), CutError>
where
    R: std::io::Read + std::io::Seek,
{
    let out = File::create(out_tmp).map_err(|_| CutError::Open)?;
    let mut writer = Mp4Writer::write_start(
        BufWriter::new(out),
        &Mp4Config {
            major_brand: (*b"M4A ").into(),
            minor_version: 512,
            compatible_brands: vec![(*b"M4A ").into(), (*b"mp42").into(), (*b"isom").into()],
            timescale: 1000,
        },
    )
    .map_err(|_| CutError::Open)?;
    writer
        .add_track(&TrackConfig {
            track_type: TrackType::Audio,
            timescale: track.timescale,
            language: "und".to_string(),
            media_conf: MediaConfig::AacConfig(track.aac.clone()),
        })
        .map_err(|_| CutError::Open)?;

    for sid in 1..=track.sample_count {
        let Some(sample) = reader
            .read_sample(track.id, sid)
            .map_err(|_| CutError::Parse)?
        else {
            continue;
        };
        if sample.start_time >= start_ts && sample.start_time < end_ts {
            // The writer's sole track is id 1.
            writer.write_sample(1, &sample).map_err(|_| CutError::Open)?;
        }
    }
    writer.write_end().map_err(|_| CutError::Open)?;
    // Drop the writer so the BufWriter flushes its tail to disk before the esds patch reads the file.
    drop(writer);
    Ok(())
}

/// Rewrites the output's esds SLConfigDescriptor `predefined` byte to 2 ("MP4"), which the `mp4` crate
/// writes as 0 - a value symphonia's isomp4 reader rejects. Walks to the moov box, scans it for every
/// esds, and patches each audio esds's SL predefined byte. Deterministic and size-preserving; a file
/// with no moov or no esds is left untouched.
fn patch_sl_predefined(path: &Path) -> Result<(), CutError> {
    let mut data = fs::read(path).map_err(|_| CutError::Open)?;
    let Some((moov_off, moov_size)) = top_level_box(&data, b"moov") else {
        return Ok(());
    };
    let mend = (moov_off + moov_size).min(data.len());
    let mut patched = false;
    let mut i = moov_off;
    while i + 4 <= mend {
        if &data[i..i + 4] == b"esds" {
            // The 4-byte size field precedes the tag.
            let esds_off = i - 4;
            let esds_size =
                u32::from_be_bytes(data[esds_off..esds_off + 4].try_into().unwrap()) as usize;
            let region_end = (esds_off + esds_size).min(mend);
            if let Some(pos) = find_sl_predefined(&data, esds_off + 12, region_end) {
                data[pos] = 0x02;
                patched = true;
            }
            i = region_end.max(i + 4);
        } else {
            i += 1;
        }
    }
    if patched {
        fs::write(path, &data).map_err(|_| CutError::Open)?;
    }
    Ok(())
}

/// Finds a top-level box by its 4-byte type, returning (offset, size). Skips preceding boxes by their
/// declared size and handles the 64-bit `size==1` extended form. None on a size that runs past the buffer.
fn top_level_box(data: &[u8], want: &[u8; 4]) -> Option<(usize, usize)> {
    let mut off = 0usize;
    while off + 8 <= data.len() {
        let mut size = u32::from_be_bytes(data[off..off + 4].try_into().ok()?) as usize;
        let name = &data[off + 4..off + 8];
        let mut hdr = 8;
        if size == 1 {
            size = u64::from_be_bytes(data[off + 8..off + 16].try_into().ok()?) as usize;
            hdr = 16;
        } else if size == 0 {
            size = data.len() - off;
        }
        if size < hdr || off + size > data.len() {
            return None;
        }
        if name == want {
            return Some((off, size));
        }
        off += size;
    }
    None
}

/// Scans the MPEG-4 descriptor chain in `[start, end)` for the SLConfigDescriptor (tag 0x06) and
/// returns the index of its first payload byte (the `predefined` field). Descends the container
/// descriptors (ES 0x03: 3 fixed bytes; DecoderConfig 0x04: 13 fixed bytes) and skips leaves by their
/// length. None when the chain holds no SLConfigDescriptor or a length field runs off the region.
fn find_sl_predefined(data: &[u8], mut i: usize, end: usize) -> Option<usize> {
    let end = end.min(data.len());
    while i < end {
        let tag = data[i];
        i += 1;
        // The descriptor length is a varint of up to four 7-bit groups.
        let mut len = 0usize;
        for _ in 0..4 {
            if i >= end {
                return None;
            }
            let b = data[i];
            i += 1;
            len = (len << 7) | (b & 0x7f) as usize;
            if b & 0x80 == 0 {
                break;
            }
        }
        match tag {
            // SLConfigDescriptor: predefined is the first payload byte.
            0x06 => return (i < end).then_some(i),
            // ES_Descriptor: ES_ID(2) + flags(1), then nested descriptors.
            0x03 => i += 3,
            // DecoderConfigDescriptor: 13 fixed bytes, then nested descriptors.
            0x04 => i += 13,
            // DecoderSpecificInfo and other leaves: skip the payload.
            _ => i += len,
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // Builds a minimal moov -> ... -> esds byte buffer whose SLConfigDescriptor predefined byte is the
    // value given, and returns (buffer, index of that byte). The box tree is only deep enough for the
    // walk: a top-level moov wrapping an esds box wrapping the descriptor chain.
    fn synthetic_moov(sl_predefined: u8) -> (Vec<u8>, usize) {
        // The descriptor chain: ES (0x03) -> DecoderConfig (0x04) -> DecoderSpecificInfo (0x05) leaf,
        // then SLConfigDescriptor (0x06) carrying the predefined byte. The descender skips 0x03 and
        // 0x04 by fixed byte counts (3 and 13) and ignores their length fields, so those lengths are
        // filler; the 0x05 leaf is skipped by its real length. Each length here is a one-byte varint.
        let mut chain = Vec::new();
        chain.push(0x03); // ES_Descriptor
        chain.push(20); // length (filler; not walked)
        chain.extend_from_slice(&[0x00, 0x00, 0x00]); // ES_ID(2) + flags(1)
        chain.push(0x04); // DecoderConfigDescriptor
        chain.push(15); // length (filler; not walked)
        chain.extend_from_slice(&[0u8; 13]); // 13 fixed bytes
        chain.push(0x05); // DecoderSpecificInfo leaf
        chain.push(2); // length
        chain.extend_from_slice(&[0x12, 0x34]); // ASC bytes
        chain.push(0x06); // SLConfigDescriptor
        chain.push(1); // length
        let sl_payload_idx_in_chain = chain.len();
        chain.push(sl_predefined); // predefined

        // Wrap the chain in an esds box: 4-byte size, "esds" tag, 4-byte version/flags, then the chain.
        let esds_body_off = 12; // size(4) + tag(4) + version/flags(4)
        let esds_size = esds_body_off + chain.len();
        let mut esds = Vec::new();
        esds.extend_from_slice(&(esds_size as u32).to_be_bytes());
        esds.extend_from_slice(b"esds");
        esds.extend_from_slice(&[0u8; 4]); // version + flags
        let sl_idx_in_esds = esds.len() + sl_payload_idx_in_chain;
        esds.extend_from_slice(&chain);

        // Wrap the esds in a top-level moov box.
        let moov_size = 8 + esds.len();
        let mut buf = Vec::new();
        buf.extend_from_slice(&(moov_size as u32).to_be_bytes());
        buf.extend_from_slice(b"moov");
        let sl_idx = buf.len() + sl_idx_in_esds;
        buf.extend_from_slice(&esds);
        (buf, sl_idx)
    }

    #[test]
    fn patch_sets_the_sl_predefined_byte_to_two() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("plisto_esds_{}.m4a", std::process::id()));
        let (buf, sl_idx) = synthetic_moov(0);
        assert_eq!(buf[sl_idx], 0, "the fixture starts with predefined 0");
        fs::write(&path, &buf).unwrap();

        patch_sl_predefined(&path).expect("patch runs");

        let patched = fs::read(&path).unwrap();
        assert_eq!(patched[sl_idx], 2, "the SL predefined byte becomes 2");
        // Every other byte is untouched: the patch is size-preserving and hits one byte.
        for (i, (a, b)) in buf.iter().zip(patched.iter()).enumerate() {
            if i != sl_idx {
                assert_eq!(a, b, "byte {i} is unchanged");
            }
        }
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn patch_is_a_clean_no_op_without_an_esds() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("plisto_no_esds_{}.m4a", std::process::id()));
        // A moov box holding no esds: the scan finds nothing and leaves the bytes as they are.
        let mut buf = Vec::new();
        let body = b"free....padding.only";
        buf.extend_from_slice(&((8 + body.len()) as u32).to_be_bytes());
        buf.extend_from_slice(b"moov");
        buf.extend_from_slice(body);
        fs::write(&path, &buf).unwrap();

        patch_sl_predefined(&path).expect("patch runs");

        assert_eq!(fs::read(&path).unwrap(), buf, "the file is untouched");
        let _ = fs::remove_file(&path);
    }
}
