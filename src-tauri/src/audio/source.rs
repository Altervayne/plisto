/*
 * The decoded-audio source the engine feeds rodio: a pull-based decoder adapted into a `Source`, plus
 * the lock-free spectrum tap it writes while it plays. Both run on rodio's mixer thread and are read
 * back on the engine thread through shared atomics.
 */

// -- Library Imports --
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Source;

// -- Local Imports --
use super::{decode, AudioSpec};

// The ring of recent mono samples the spectrum reader taps. A power of two so the write index masks
// cheaply; the reader grabs the trailing SPECTRUM_WINDOW for one FFT.
pub(super) const SPECTRUM_RING: usize = 2048;
pub(super) const SPECTRUM_WINDOW: usize = 1024;
/// Spectrum bands emitted per frame. The mini three-bar EQ folds its bars out of these.
pub const BAND_COUNT: usize = 24;

/// A lock-free tap of the playing audio for the spectrum reader. One writer on rodio's mixer thread,
/// read for display only on the engine thread, so Relaxed is the right ordering, not a sync gate.
/// Each mono sample rides as its f32 bits in an AtomicU32.
pub(super) struct SpectrumTap {
    pub(super) ring: [AtomicU32; SPECTRUM_RING],
    // Total mono frames pushed since this source began, the write cursor into the ring.
    pub(super) written: AtomicU64,
}

impl SpectrumTap {
    /// A silent tap: the ring zeroed and the cursor at the start.
    fn new() -> Self {
        Self {
            ring: std::array::from_fn(|_| AtomicU32::new(0)),
            written: AtomicU64::new(0),
        }
    }
}

/// Adapts a pull-based `decode::Decoder` into a rodio `Source`: rodio pulls one interleaved f32
/// sample at a time, and this refills from the decoder a packet at a time as it drains. A shared
/// frame counter ticks once per full frame so the engine can read the play position without locking
/// or querying the sink.
pub(super) struct DecoderSource {
    decoder: decode::Decoder,
    buffer: Vec<f32>,
    pos: usize,
    pub(super) spec: AudioSpec,
    // Shared with the engine so it reads the play head while the audio thread writes it. Single
    // writer here, read for display only, so Relaxed is the right ordering - not a sync gate.
    pub(super) frames: Arc<AtomicU64>,
    // The spectrum reader's tap, written one mono sample per completed frame, same split as `frames`.
    pub(super) spectrum: Arc<SpectrumTap>,
    // Running sum of the current frame's channels, downmixed to mono when the frame completes.
    frame_sum: f32,
    chan_cursor: u16,
    pub(super) duration: Option<Duration>,
    done: bool,
}

impl DecoderSource {
    /// Primes the first packet so `channels()`/`sample_rate()` report the real layout immediately,
    /// never zero, and seeds the frame counter to `start_frame` (the resume point after a seek).
    /// Returns None when the stream yields no first packet - an empty or unreadable file.
    pub(super) fn new(mut decoder: decode::Decoder, start_frame: u64) -> Option<Self> {
        let first = decoder.next_packet()?;
        let duration = decoder
            .duration_secs()
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(Duration::from_secs_f64);
        Some(Self {
            spec: first.spec,
            buffer: first.samples,
            pos: 0,
            decoder,
            frames: Arc::new(AtomicU64::new(start_frame)),
            spectrum: Arc::new(SpectrumTap::new()),
            frame_sum: 0.0,
            chan_cursor: 0,
            duration,
            done: false,
        })
    }
}

impl Iterator for DecoderSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.pos >= self.buffer.len() {
            match self.decoder.next_packet() {
                Some(chunk) => {
                    self.buffer = chunk.samples;
                    self.pos = 0;
                    self.spec = chunk.spec;
                }
                None => {
                    self.done = true;
                    return None;
                }
            }
        }
        // A refilled packet is never empty in practice, but guard the index so a degenerate empty
        // packet ends the stream cleanly instead of panicking on the audio thread.
        if self.pos >= self.buffer.len() {
            self.done = true;
            return None;
        }
        let s = self.buffer[self.pos];
        self.pos += 1;
        self.chan_cursor += 1;
        self.frame_sum += s;
        if self.chan_cursor >= self.spec.channels {
            self.chan_cursor = 0;
            // Downmix the frame to mono (sum over channels, not channel 0) so hard-panned content
            // still lights the bars, then push it to the tap at the next ring slot. No lock, no alloc.
            let mono = self.frame_sum / self.spec.channels as f32;
            let slot = (self.spectrum.written.load(Ordering::Relaxed) as usize) & (SPECTRUM_RING - 1);
            self.spectrum.ring[slot].store(mono.to_bits(), Ordering::Relaxed);
            self.spectrum.written.fetch_add(1, Ordering::Relaxed);
            self.frame_sum = 0.0;
            self.frames.fetch_add(1, Ordering::Relaxed);
        }
        Some(s)
    }
}

impl Source for DecoderSource {
    fn current_frame_len(&self) -> Option<usize> {
        // The samples left in the current buffer. None (never Some(0)) at a packet boundary tells
        // rodio to re-read the spec on the next pull, which is where a mid-stream layout change
        // would take effect.
        let rem = self.buffer.len().saturating_sub(self.pos);
        if rem == 0 {
            None
        } else {
            Some(rem)
        }
    }

    fn channels(&self) -> u16 {
        self.spec.channels
    }

    fn sample_rate(&self) -> u32 {
        self.spec.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    // ---- DecoderSource frame counting ----

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plisto_engine_{tag}_{}_{n}_{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // A canonical 16-bit PCM WAV: the 44-byte header plus interleaved little-endian i16 frames,
    // ramping so the decoded signal is known and in range. Mirrors the decoder test's helper.
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

        fs::write(path, v).unwrap();
    }

    #[test]
    fn decoder_source_counts_one_frame_per_channel_group() {
        let dir = TempDir::new("count");
        let path = dir.path.join("tone.wav");
        let (rate, channels, frames) = (44_100u32, 2u16, 2_000usize);
        write_wav(&path, rate, channels, frames);

        let dec = decode::Decoder::open(&path).expect("opens the WAV");
        let src = DecoderSource::new(dec, 0).expect("primes the first packet");
        assert_eq!(src.channels(), channels);
        assert_eq!(src.sample_rate(), rate);

        let counter = Arc::clone(&src.frames);
        let samples: Vec<f32> = src.collect();
        assert_eq!(samples.len(), frames * channels as usize);
        assert_eq!(counter.load(Ordering::Relaxed), frames as u64);
    }

    #[test]
    fn decoder_source_seeds_the_start_frame() {
        let dir = TempDir::new("seed");
        let path = dir.path.join("tone.wav");
        let (rate, channels, frames) = (44_100u32, 2u16, 1_000usize);
        write_wav(&path, rate, channels, frames);

        let dec = decode::Decoder::open(&path).expect("opens the WAV");
        let src = DecoderSource::new(dec, 500).expect("primes the first packet");
        assert_eq!(src.frames.load(Ordering::Relaxed), 500);

        let counter = Arc::clone(&src.frames);
        let _: Vec<f32> = src.collect();
        // Draining from the seed advances the counter by the file's frame count.
        assert_eq!(counter.load(Ordering::Relaxed), 500 + frames as u64);
    }
}
