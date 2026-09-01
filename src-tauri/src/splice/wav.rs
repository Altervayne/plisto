/*
 * The lossless WAV cutter: copy a frame range out of a RIFF/WAVE file as a fresh, valid WAV without
 * decoding a single sample. It walks the source chunks to read the format and locate the PCM data,
 * then writes a canonical header followed by the exact byte slice of the requested frames. The source
 * is opened read-only and the data slice is streamed, so a huge file is never loaded whole.
 */

// -- Library Imports --
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

// -- Local Imports --
use super::CutError;

// The largest byte-slice read at once while streaming the PCM range into the output.
const COPY_CHUNK: usize = 64 * 1024;

/// The source's format and the location of its PCM: the whole `fmt ` chunk body (written verbatim),
/// the bytes per frame, and the data chunk's byte offset and length in the file.
struct WavLayout {
    fmt_body: Vec<u8>,
    block_align: u64,
    data_offset: u64,
    data_len: u64,
}

/// Cuts frames `[start_frame, end_frame)` out of the WAV at `source` into a fresh canonical WAV at
/// `out_tmp`. The PCM bytes are copied verbatim - no decode, no re-encode - so the cut is bit-exact.
/// An `end_frame` past the data is clamped to the data end; a `start_frame` past it yields an empty
/// data chunk. Fails on a source that is not a parseable PCM WAV.
pub fn cut(
    source: &Path,
    start_frame: u64,
    end_frame: u64,
    out_tmp: &Path,
) -> Result<(), CutError> {
    let mut file = File::open(source).map_err(|_| CutError::Open)?;
    let layout = parse_layout(&mut file)?;
    if layout.block_align == 0 {
        return Err(CutError::Parse);
    }

    let data_end = layout.data_offset + layout.data_len;
    let start_byte = layout
        .data_offset
        .saturating_add(start_frame.saturating_mul(layout.block_align))
        .min(data_end);
    let end_byte = layout
        .data_offset
        .saturating_add(end_frame.saturating_mul(layout.block_align))
        .min(data_end);
    let slice_len = end_byte.saturating_sub(start_byte);

    write_output(out_tmp, &layout, &mut file, start_byte, slice_len)
}

/// Walks the RIFF chunks, capturing the `fmt ` body and the `data` chunk's offset and length. Reads
/// only chunk headers and the small `fmt ` body, seeking over every chunk's payload, so the data is
/// never pulled into memory here.
fn parse_layout(file: &mut File) -> Result<WavLayout, CutError> {
    let mut header = [0u8; 12];
    file.read_exact(&mut header).map_err(|_| CutError::Parse)?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(CutError::Parse);
    }

    let mut fmt_body: Option<Vec<u8>> = None;
    let mut data: Option<(u64, u64)> = None;

    loop {
        let mut chunk_header = [0u8; 8];
        if file.read_exact(&mut chunk_header).is_err() {
            break;
        }
        let id = &chunk_header[0..4];
        let size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]) as u64;

        if id == b"fmt " {
            let mut body = vec![0u8; size as usize];
            file.read_exact(&mut body).map_err(|_| CutError::Parse)?;
            fmt_body = Some(body);
            // A chunk with an odd size carries a trailing pad byte the size does not count.
            if size % 2 == 1 {
                file.seek(SeekFrom::Current(1))
                    .map_err(|_| CutError::Parse)?;
            }
        } else if id == b"data" {
            let offset = file.stream_position().map_err(|_| CutError::Parse)?;
            data = Some((offset, size));
            // No need to read the PCM: skip past it (plus any pad byte) and keep scanning.
            let skip = size + (size % 2);
            file.seek(SeekFrom::Current(skip as i64))
                .map_err(|_| CutError::Parse)?;
        } else {
            let skip = size + (size % 2);
            file.seek(SeekFrom::Current(skip as i64))
                .map_err(|_| CutError::Parse)?;
        }

        if fmt_body.is_some() && data.is_some() {
            break;
        }
    }

    let fmt_body = fmt_body.ok_or(CutError::Parse)?;
    let (data_offset, data_len) = data.ok_or(CutError::Parse)?;
    if fmt_body.len() < 16 {
        return Err(CutError::Parse);
    }
    // block_align (bytes per frame) sits at fmt bytes 12..14. Fall back to channels x bytes-per-sample
    // when a broken encoder leaves it zero.
    let block_align = match u16::from_le_bytes([fmt_body[12], fmt_body[13]]) {
        0 => {
            let channels = u16::from_le_bytes([fmt_body[2], fmt_body[3]]) as u64;
            let bits = u16::from_le_bytes([fmt_body[14], fmt_body[15]]) as u64;
            channels * bits.div_ceil(8)
        }
        n => n as u64,
    };

    Ok(WavLayout {
        fmt_body,
        block_align,
        data_offset,
        data_len,
    })
}

/// Writes the canonical output: `RIFF` + size + `WAVE`, the source `fmt ` chunk verbatim, then a
/// `data` chunk whose body is the exact PCM slice streamed from the source. An odd-length slice is
/// padded with a trailing zero byte the declared size does not count, matching the RIFF convention.
fn write_output(
    out_tmp: &Path,
    layout: &WavLayout,
    source: &mut File,
    start_byte: u64,
    slice_len: u64,
) -> Result<(), CutError> {
    let mut out = File::create(out_tmp).map_err(|_| CutError::Open)?;

    let fmt_len = layout.fmt_body.len() as u64;
    let fmt_pad = fmt_len % 2;
    let data_pad = slice_len % 2;
    // The RIFF size covers everything after the 8-byte RIFF header: the WAVE tag, the fmt chunk (with
    // its own header and any pad), and the data chunk (header, body, and any pad).
    let riff_size = 4 + (8 + fmt_len + fmt_pad) + (8 + slice_len + data_pad);

    out.write_all(b"RIFF").map_err(|_| CutError::Open)?;
    out.write_all(&(riff_size as u32).to_le_bytes())
        .map_err(|_| CutError::Open)?;
    out.write_all(b"WAVE").map_err(|_| CutError::Open)?;

    out.write_all(b"fmt ").map_err(|_| CutError::Open)?;
    out.write_all(&(fmt_len as u32).to_le_bytes())
        .map_err(|_| CutError::Open)?;
    out.write_all(&layout.fmt_body)
        .map_err(|_| CutError::Open)?;
    if fmt_pad == 1 {
        out.write_all(&[0u8]).map_err(|_| CutError::Open)?;
    }

    out.write_all(b"data").map_err(|_| CutError::Open)?;
    out.write_all(&(slice_len as u32).to_le_bytes())
        .map_err(|_| CutError::Open)?;

    copy_range(source, start_byte, slice_len, &mut out)?;
    if data_pad == 1 {
        out.write_all(&[0u8]).map_err(|_| CutError::Open)?;
    }

    Ok(())
}

/// Streams `len` bytes from `source` starting at `start`, copying them into `out` in bounded blocks so
/// the whole slice is never held in memory at once.
fn copy_range(source: &mut File, start: u64, len: u64, out: &mut File) -> Result<(), CutError> {
    source
        .seek(SeekFrom::Start(start))
        .map_err(|_| CutError::Open)?;
    let mut remaining = len;
    let mut buf = vec![0u8; COPY_CHUNK];
    while remaining > 0 {
        let want = remaining.min(COPY_CHUNK as u64) as usize;
        source
            .read_exact(&mut buf[..want])
            .map_err(|_| CutError::Parse)?;
        out.write_all(&buf[..want]).map_err(|_| CutError::Open)?;
        remaining -= want as u64;
    }
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
                std::env::temp_dir().join(format!("plisto_wav_{}_{n}_{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // A canonical 16-bit PCM WAV: the 44-byte header plus interleaved little-endian i16 frames that
    // ramp across the buffer, so the data bytes are a known, non-constant signal. Mirrors the decoder
    // test helper's header shape.
    fn write_wav(path: &Path, rate: u32, channels: u16, frames: usize) {
        let bits = 16u16;
        let block_align = channels * bits / 8;
        let byte_rate = rate * block_align as u32;
        let data_len = (frames * channels as usize * (bits / 8) as usize) as u32;

        let mut v = Vec::with_capacity(44 + data_len as usize);
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(b"fmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&byte_rate.to_le_bytes());
        v.extend_from_slice(&block_align.to_le_bytes());
        v.extend_from_slice(&bits.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        for frame in 0..frames {
            let phase = (frame % 200) as i32 - 100;
            let sample = (phase * 300) as i16;
            for _ in 0..channels {
                v.extend_from_slice(&sample.to_le_bytes());
            }
        }
        std::fs::write(path, v).unwrap();
    }

    // Reads the source's raw data-chunk bytes for the given frame range, to compare against the cut.
    fn source_data_range(
        path: &Path,
        block_align: u64,
        start_frame: u64,
        end_frame: u64,
    ) -> Vec<u8> {
        let bytes = std::fs::read(path).unwrap();
        // The canonical header is 44 bytes; data begins there.
        let data_start = 44 + (start_frame * block_align) as usize;
        let data_end = 44 + (end_frame * block_align) as usize;
        bytes[data_start..data_end].to_vec()
    }

    // Parses an output WAV's data chunk into (block_align, data bytes), proving the header is valid.
    fn read_output_data(path: &Path) -> Vec<u8> {
        let mut f = File::open(path).unwrap();
        let layout = parse_layout(&mut f).unwrap();
        let mut data = vec![0u8; layout.data_len as usize];
        f.seek(SeekFrom::Start(layout.data_offset)).unwrap();
        f.read_exact(&mut data).unwrap();
        data
    }

    #[test]
    fn cut_extracts_a_bit_identical_pcm_range() {
        let dir = TempDir::new();
        let source = dir.path.join("in.wav");
        let out = dir.path.join("out.wav");
        // Stereo 16-bit: block_align is 4 bytes per frame.
        write_wav(&source, 44_100, 2, 2_000);
        let block_align = 4u64;

        cut(&source, 500, 1_500, &out).unwrap();

        let expected = source_data_range(&source, block_align, 500, 1_500);
        let got = read_output_data(&out);
        assert_eq!(
            got.len(),
            1_000 * block_align as usize,
            "one thousand frames"
        );
        assert_eq!(
            got, expected,
            "the cut data equals the exact source byte range"
        );
    }

    #[test]
    fn cut_clamps_an_end_past_the_data() {
        let dir = TempDir::new();
        let source = dir.path.join("in.wav");
        let out = dir.path.join("out.wav");
        write_wav(&source, 22_050, 1, 1_000);
        let block_align = 2u64;

        // Ask for far more frames than exist; the end clamps to the data end.
        cut(&source, 900, 100_000, &out).unwrap();

        let expected = source_data_range(&source, block_align, 900, 1_000);
        let got = read_output_data(&out);
        assert_eq!(got, expected, "the end clamps to the last frame");
    }

    #[test]
    fn cut_reopens_as_a_valid_wav_through_the_decoder() {
        let dir = TempDir::new();
        let source = dir.path.join("in.wav");
        let out = dir.path.join("out.wav");
        write_wav(&source, 48_000, 2, 4_000);

        cut(&source, 1_000, 3_000, &out).unwrap();

        // The decoder opens the cut and reports the source's spec, proving a well-formed header.
        let decoder = crate::audio::Decoder::open(&out).expect("the cut opens as a WAV");
        assert_eq!(decoder.spec().sample_rate, 48_000);
        assert_eq!(decoder.spec().channels, 2);
        assert_eq!(decoder.total_frames(), Some(2_000));
    }

    #[test]
    fn a_non_wav_source_is_a_parse_error() {
        let dir = TempDir::new();
        let source = dir.path.join("junk.wav");
        let out = dir.path.join("out.wav");
        std::fs::write(&source, b"not a riff file at all").unwrap();
        assert_eq!(cut(&source, 0, 10, &out), Err(CutError::Parse));
    }
}
