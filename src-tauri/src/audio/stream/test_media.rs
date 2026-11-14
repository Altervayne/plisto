/*
 * Encoded audio built in memory for the stream tests: no fixture file and no encoder beyond the
 * opus-rs one already in the tree. FLAC uses verbatim subframes; the ADTS and MP3 frames are silent
 * frames written bit by bit, enough to drive the real demuxer and decoder of each format.
 */

// -- Library Imports --
use ogg::writing::{PacketWriteEndInfo, PacketWriter};

/// A triangle ramp between the rails, so every frame carries a known non-zero value.
pub fn ramp(frame: usize) -> i16 {
    let phase = (frame % 200) as i32 - 100;
    (phase * 300) as i16
}

/// A canonical 16-bit PCM WAV of `frames` ramp frames, every channel alike.
pub fn wav_bytes(rate: u32, channels: u16, frames: usize) -> Vec<u8> {
    let block_align = channels * 2;
    let data_len = (frames * block_align as usize) as u32;
    let mut v = Vec::with_capacity(44 + data_len as usize);
    v.extend_from_slice(b"RIFF");
    v.extend_from_slice(&(36 + data_len).to_le_bytes());
    v.extend_from_slice(b"WAVEfmt ");
    v.extend_from_slice(&16u32.to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes());
    v.extend_from_slice(&channels.to_le_bytes());
    v.extend_from_slice(&rate.to_le_bytes());
    v.extend_from_slice(&(rate * block_align as u32).to_le_bytes());
    v.extend_from_slice(&block_align.to_le_bytes());
    v.extend_from_slice(&16u16.to_le_bytes());
    v.extend_from_slice(b"data");
    v.extend_from_slice(&data_len.to_le_bytes());
    for frame in 0..frames {
        for _ in 0..channels {
            v.extend_from_slice(&ramp(frame).to_le_bytes());
        }
    }
    v
}

fn crc8(data: &[u8]) -> u8 {
    let mut c = 0u8;
    for &b in data {
        c ^= b;
        for _ in 0..8 {
            c = if c & 0x80 != 0 {
                (c << 1) ^ 0x07
            } else {
                c << 1
            };
        }
    }
    c
}

fn crc16(data: &[u8]) -> u16 {
    let mut c = 0u16;
    for &b in data {
        c ^= (b as u16) << 8;
        for _ in 0..8 {
            c = if c & 0x8000 != 0 {
                (c << 1) ^ 0x8005
            } else {
                c << 1
            };
        }
    }
    c
}

/// The usual FLAC block size for `flac_bytes`.
pub const FLAC_BLOCK: usize = 1_024;

// A FLAC frame number in its UTF-8-like coding, up to 2^21 - 1.
fn frame_number(n: usize, out: &mut Vec<u8>) {
    match n {
        0..=0x7F => out.push(n as u8),
        0x80..=0x7FF => out.extend_from_slice(&[0xC0 | (n >> 6) as u8, 0x80 | (n & 0x3F) as u8]),
        0x800..=0xFFFF => out.extend_from_slice(&[
            0xE0 | (n >> 12) as u8,
            0x80 | ((n >> 6) & 0x3F) as u8,
            0x80 | (n & 0x3F) as u8,
        ]),
        _ => out.extend_from_slice(&[
            0xF0 | (n >> 18) as u8,
            0x80 | ((n >> 12) & 0x3F) as u8,
            0x80 | ((n >> 6) & 0x3F) as u8,
            0x80 | (n & 0x3F) as u8,
        ]),
    }
}

/// A mono 16-bit 44.1 kHz FLAC of `blocks` ramp blocks of `block_size` frames (at least 16),
/// every subframe verbatim.
pub fn flac_bytes(blocks: usize, block_size: usize) -> Vec<u8> {
    let total = (blocks * block_size) as u64;
    let mut v = b"fLaC".to_vec();
    // Last metadata block, STREAMINFO, 34 bytes.
    v.extend_from_slice(&[0x80, 0x00, 0x00, 0x22]);
    v.extend_from_slice(&(block_size as u16).to_be_bytes());
    v.extend_from_slice(&(block_size as u16).to_be_bytes());
    v.extend_from_slice(&[0; 6]);
    // sample_rate(20) | channels-1(3) | bits-1(5) | total_samples(36).
    let packed = (44_100u64 << 44) | (15u64 << 36) | total;
    v.extend_from_slice(&packed.to_be_bytes());
    v.extend_from_slice(&[0; 16]);

    for block in 0..blocks {
        let mut frame = vec![
            0xFF, 0xF8, // Block size from a 16-bit field after the header; 44.1 kHz.
            0x79, // Mono; 16 bits per sample.
            0x08,
        ];
        frame_number(block, &mut frame);
        frame.extend_from_slice(&((block_size - 1) as u16).to_be_bytes());
        frame.push(crc8(&frame));
        // Verbatim subframe, no wasted bits.
        frame.push(0x02);
        for i in 0..block_size {
            frame.extend_from_slice(&ramp(block * block_size + i).to_be_bytes());
        }
        let crc = crc16(&frame);
        frame.extend_from_slice(&crc.to_be_bytes());
        v.extend(frame);
    }
    v
}

/// Opus frames per packet of `ogg_opus_bytes`: 20 ms at 48 kHz.
pub const OPUS_FRAME: usize = 960;

/// One Ogg Opus physical stream on `serial`: `packets` packets of a 440 Hz tone behind an OpusHead
/// carrying `pre_skip`.
pub fn ogg_opus_bytes(serial: u32, channels: usize, packets: usize, pre_skip: u16) -> Vec<u8> {
    use opus_rs::{Application, OpusEncoder};

    let mut head = b"OpusHead".to_vec();
    head.push(1);
    head.push(channels as u8);
    head.extend_from_slice(&pre_skip.to_le_bytes());
    head.extend_from_slice(&48_000u32.to_le_bytes());
    head.extend_from_slice(&0u16.to_le_bytes());
    head.push(0);
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&4u32.to_le_bytes());
    tags.extend_from_slice(b"test");
    tags.extend_from_slice(&0u32.to_le_bytes());

    let mut enc =
        OpusEncoder::new(48_000, channels, Application::Audio).expect("builds the encoder");
    let mut scratch = vec![0u8; 4_000];
    let mut writer = PacketWriter::new(Vec::new());
    writer
        .write_packet(head, serial, PacketWriteEndInfo::EndPage, 0)
        .unwrap();
    writer
        .write_packet(tags, serial, PacketWriteEndInfo::EndPage, 0)
        .unwrap();
    let mut granule = pre_skip as u64;
    for p in 0..packets {
        let mut input = vec![0.0f32; OPUS_FRAME * channels];
        for i in 0..OPUS_FRAME {
            let n = (p * OPUS_FRAME + i) as f32;
            let s = (n * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5;
            for ch in 0..channels {
                input[i * channels + ch] = s;
            }
        }
        let len = enc
            .encode(&input, OPUS_FRAME, &mut scratch)
            .expect("encodes a frame");
        granule += OPUS_FRAME as u64;
        let info = if p + 1 == packets {
            PacketWriteEndInfo::EndStream
        } else if (p + 1) % 10 == 0 {
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        writer
            .write_packet(scratch[..len].to_vec(), serial, info, granule)
            .unwrap();
    }
    writer.into_inner()
}

/// `count` silent ADTS AAC-LC frames, mono 44.1 kHz, no CRC. Each raw block is one single channel
/// element with `max_sfb` 0 (no spectral data), then the end element.
pub fn adts_silence(count: usize) -> Vec<u8> {
    const RAW: [u8; 4] = [0x00, 0xC8, 0x00, 0x07];
    let frame_len = 7 + RAW.len();
    let mut v = Vec::with_capacity(count * frame_len);
    for _ in 0..count {
        // MPEG-4, no CRC; LC, 44.1 kHz, one channel; frame length; buffer fullness 0x7FF; one block.
        v.extend_from_slice(&[
            0xFF,
            0xF1,
            0x50,
            0x40 | ((frame_len >> 11) & 0x03) as u8,
            ((frame_len >> 3) & 0xFF) as u8,
            (((frame_len & 0x07) << 5) as u8) | 0x1F,
            0xFC,
        ]);
        v.extend_from_slice(&RAW);
    }
    v
}

/// An ADTS header whose sample rate index is the forbidden 15: the demuxer refuses it mid-stream.
pub const ADTS_BAD_HEADER: [u8; 7] = [0xFF, 0xF1, 0x7C, 0x40, 0x01, 0x7F, 0xFC];

/// Frames per MPEG-1 Layer III frame.
pub const MP3_FRAME: usize = 1_152;

/// `count` silent MPEG-1 Layer III frames, mono 44.1 kHz at 128 kbps: the header, then side info
/// and main data all zero (no Huffman data in either granule).
pub fn mp3_silence(count: usize) -> Vec<u8> {
    // 144 x 128000 / 44100, no padding.
    const FRAME_BYTES: usize = 417;
    let mut v = Vec::with_capacity(count * FRAME_BYTES);
    for _ in 0..count {
        v.extend_from_slice(&[0xFF, 0xFB, 0x90, 0xC0]);
        v.extend(std::iter::repeat_n(0u8, FRAME_BYTES - 4));
    }
    v
}
