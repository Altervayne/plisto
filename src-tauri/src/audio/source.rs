/*
 * The decoded-audio source the engine feeds rodio: a pull-based decoder adapted into a `Source`, its
 * DSP stage, and the lock-free spectrum tap it writes while it plays. All run on rodio's mixer thread
 * and are read back on the engine thread through shared atomics. `open_source` is the one way a
 * source is built, so every path gets the same stage and the same start seed.
 */

// -- Library Imports --
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rodio::Source;

// -- Local Imports --
use super::dsp::{DspShared, DspStage};
use super::{decode, AudioSpec};

// The ring of recent mono samples the spectrum reader taps. A power of two so the write index masks
// cheaply; the reader grabs the trailing SPECTRUM_WINDOW for one FFT.
pub(super) const SPECTRUM_RING: usize = 2048;
pub(super) const SPECTRUM_WINDOW: usize = 1024;
/// Spectrum bands emitted per frame. The mini three-bar EQ folds its bars out of these.
pub const BAND_COUNT: usize = 24;
/// Bands in the fine spectrum frame, over the same range and window as the regular bands.
pub const FINE_BAND_COUNT: usize = 128;

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
/// sample at a time, and this refills from the decoder a packet at a time as it drains. Each sample
/// runs through the DSP stage before anything else sees it. A shared frame counter ticks once per
/// full frame so the engine can read the play position without locking or querying the sink.
pub(super) struct DecoderSource {
    decoder: decode::Decoder,
    buffer: Vec<f32>,
    pos: usize,
    pub(super) spec: AudioSpec,
    stage: DspStage,
    // Shared with the engine so it reads the play head while the audio thread writes it. Single
    // writer here, read for display only, so Relaxed is the right ordering - not a sync gate.
    pub(super) frames: Arc<AtomicU64>,
    // The spectrum reader's tap, written one mono sample per completed frame, same split as `frames`.
    pub(super) spectrum: Arc<SpectrumTap>,
    // Running sum of the current frame's channels, downmixed to mono when the frame completes.
    frame_sum: f32,
    chan_cursor: u16,
    pub(super) duration: Option<Duration>,
    // Set once the stream has yielded its last sample, read by the engine. Same split as `frames`.
    pub(super) ended: Arc<AtomicBool>,
    // Set by the engine to drop a queued source: it then yields None at once, so rodio moves past it
    // without playing a sample. `ended` stays unset, since the stream did not drain.
    pub(super) cancel: Arc<AtomicBool>,
}

impl DecoderSource {
    /// Primes the first packet so `channels()`/`sample_rate()` report the real layout immediately,
    /// never zero, and seeds the frame counter at `start_secs` (the resume point after a seek) on the
    /// primed rate. Returns None when the stream yields no first packet - an empty or unreadable file.
    pub(super) fn new(
        mut decoder: decode::Decoder,
        start_secs: f64,
        mut stage: DspStage,
    ) -> Option<Self> {
        let first = decoder.next_packet()?;
        // Tuned to the primed layout, the stage lands on its target before the first sample.
        stage.refresh(first.spec);
        let duration = decoder
            .duration_secs()
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(Duration::from_secs_f64);
        let rate = first.spec.sample_rate;
        let start_frame = if rate > 0 {
            (start_secs.max(0.0) * rate as f64).floor() as u64
        } else {
            0
        };
        Some(Self {
            spec: first.spec,
            buffer: first.samples,
            pos: 0,
            stage,
            decoder,
            frames: Arc::new(AtomicU64::new(start_frame)),
            spectrum: Arc::new(SpectrumTap::new()),
            frame_sum: 0.0,
            chan_cursor: 0,
            duration,
            ended: Arc::new(AtomicBool::new(false)),
            cancel: Arc::new(AtomicBool::new(false)),
        })
    }
}

/// Opens `path` as a playable source, seeking to `start_secs` when one is given, with a DSP stage
/// on `dsp` carrying the track's levelling gain. None when the file does not open, the seek fails,
/// or the stream yields no first packet. A start of None reads from the top without seeking, which
/// keeps the decoder's own priming intact.
pub(super) fn open_source(
    path: &Path,
    start_secs: Option<f64>,
    gain_db: f32,
    dsp: &Arc<DspShared>,
) -> Option<DecoderSource> {
    let mut decoder = decode::Decoder::open(path).ok()?;
    if let Some(secs) = start_secs {
        decoder.seek(secs).ok()?;
    }
    let stage = DspStage::new(Arc::clone(dsp), gain_db);
    DecoderSource::new(decoder, start_secs.unwrap_or(0.0), stage)
}

impl Iterator for DecoderSource {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if self.cancel.load(Ordering::Relaxed) {
            return None;
        }
        if self.pos >= self.buffer.len() {
            match self.decoder.next_packet() {
                Some(chunk) => {
                    self.buffer = chunk.samples;
                    self.pos = 0;
                    self.spec = chunk.spec;
                    self.stage.refresh(self.spec);
                }
                None => {
                    self.ended.store(true, Ordering::Relaxed);
                    return None;
                }
            }
        }
        // A refilled packet is never empty in practice, but guard the index so a degenerate empty
        // packet ends the stream cleanly instead of panicking on the audio thread.
        if self.pos >= self.buffer.len() {
            self.ended.store(true, Ordering::Relaxed);
            return None;
        }
        // The tap and rodio both take the processed sample, so the visuals follow the DSP.
        let s = self.stage.process(self.buffer[self.pos], self.chan_cursor);
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
        // The samples left in the current buffer, or None (never Some(0)) at a packet boundary.
        // rodio's queue does not re-read the spec on None: a source whose layout differs from the
        // one before it has its first block misread, which is why spec-changing boundaries stay
        // cold (see the boundary tests below).
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
    use crate::audio::dsp::db_to_gain;
    use rodio::source::UniformSourceIterator;
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

    // The source over `path` with an identity stage, built the way the engine builds one.
    fn identity_source(path: &Path, start_secs: Option<f64>) -> Option<DecoderSource> {
        open_source(path, start_secs, 0.0, &Arc::new(DspShared::default()))
    }

    // Every sample the decoder yields for `path`, with no source or stage in between.
    fn raw_samples(path: &Path) -> Vec<f32> {
        let mut dec = decode::Decoder::open(path).expect("opens the WAV");
        let mut out = Vec::new();
        while let Some(chunk) = dec.next_packet() {
            out.extend_from_slice(&chunk.samples);
        }
        out
    }

    // The tap ring in slot order, as bits so a comparison is exact.
    fn ring_bits(tap: &SpectrumTap) -> Vec<u32> {
        tap.ring.iter().map(|a| a.load(Ordering::Relaxed)).collect()
    }

    #[test]
    fn decoder_source_counts_one_frame_per_channel_group() {
        let dir = TempDir::new("count");
        let path = dir.path.join("tone.wav");
        let (rate, channels, frames) = (44_100u32, 2u16, 2_000usize);
        write_wav(&path, rate, channels, frames);

        let src = identity_source(&path, None).expect("primes the first packet");
        assert_eq!(src.channels(), channels);
        assert_eq!(src.sample_rate(), rate);

        let counter = Arc::clone(&src.frames);
        let ended = Arc::clone(&src.ended);
        assert!(!ended.load(Ordering::Relaxed));
        let samples: Vec<f32> = src.collect();
        assert_eq!(samples.len(), frames * channels as usize);
        assert_eq!(counter.load(Ordering::Relaxed), frames as u64);
        assert!(
            ended.load(Ordering::Relaxed),
            "a drained source reports it ended"
        );
    }

    #[test]
    fn decoder_source_seeds_the_start_frame() {
        let dir = TempDir::new("seed");
        let path = dir.path.join("tone.wav");
        // 0.0625 s at 8 kHz is exactly frame 500, so the seed has no rounding to argue about.
        let (rate, channels, frames) = (8_000u32, 2u16, 1_000usize);
        write_wav(&path, rate, channels, frames);

        let src = identity_source(&path, Some(0.0625)).expect("seeks and primes");
        assert_eq!(src.frames.load(Ordering::Relaxed), 500);

        let counter = Arc::clone(&src.frames);
        let samples: Vec<f32> = src.collect();
        // Draining from the seed advances the counter by the frames left after the seek point.
        assert_eq!(
            counter.load(Ordering::Relaxed),
            500 + (samples.len() / channels as usize) as u64
        );
    }

    #[test]
    fn identity_output_is_the_raw_decoder_output_bit_for_bit() {
        let dir = TempDir::new("identity");
        let path = dir.path.join("tone.wav");
        write_wav(&path, 44_100, 2, 3_000);

        let raw = raw_samples(&path);
        let played: Vec<f32> = identity_source(&path, None)
            .expect("primes the first packet")
            .collect();
        let bits = |v: &[f32]| v.iter().map(|s| s.to_bits()).collect::<Vec<u32>>();
        assert_eq!(bits(&played), bits(&raw));
    }

    #[test]
    fn the_tap_reads_the_processed_sample() {
        let dir = TempDir::new("tap");
        let path = dir.path.join("tone.wav");
        // More frames than the ring holds, so every slot is written.
        write_wav(&path, 44_100, 2, 3_000);

        let plain = identity_source(&path, None).expect("primes the first packet");
        let plain_tap = Arc::clone(&plain.spectrum);
        let plain_out: Vec<f32> = plain.collect();

        let dec = decode::Decoder::open(&path).expect("opens the WAV");
        let halved = DecoderSource::new(dec, 0.0, DspStage::with_preamp(-6.0)).expect("primes");
        let halved_tap = Arc::clone(&halved.spectrum);
        let halved_out: Vec<f32> = halved.collect();

        // The WAV stays under the limiter's knee, so the stage is the plain gain, and both channels
        // carry the same sample, so the mono downmix commutes with it: the comparison is bit for bit.
        let gain = db_to_gain(-6.0);
        let expect_out: Vec<f32> = plain_out.iter().map(|s| s * gain).collect();
        assert_eq!(bits(&halved_out), bits(&expect_out));
        let expect_ring: Vec<u32> = ring_bits(&plain_tap)
            .into_iter()
            .map(|b| (f32::from_bits(b) * gain).to_bits())
            .collect();
        assert!(expect_ring.iter().any(|&b| f32::from_bits(b) != 0.0));
        assert_eq!(ring_bits(&halved_tap), expect_ring);
    }

    // ---- The rodio queue boundary ----

    fn bits(v: &[f32]) -> Vec<u32> {
        v.iter().map(|s| s.to_bits()).collect()
    }

    // Drains `it` sample by sample. `collect` would ask rodio's converters for a size hint, and their
    // channel arithmetic overflows in debug builds.
    fn drain(it: impl Iterator<Item = f32>) -> Vec<f32> {
        let mut out = Vec::new();
        for s in it {
            out.push(s);
        }
        out
    }

    fn src(path: &Path) -> DecoderSource {
        identity_source(path, None).expect("primes the first packet")
    }

    // What the output mixer renders for `sources` played back to back through one rodio queue,
    // converted to `channels` at `rate`: the mixer wraps a sink's queue in exactly this converter.
    fn through_queue(sources: Vec<DecoderSource>, channels: u16, rate: u32) -> Vec<f32> {
        let (input, output) = rodio::queue::queue::<f32>(false);
        for s in sources {
            input.append(s);
        }
        drain(UniformSourceIterator::<_, f32>::new(output, channels, rate))
    }

    // `path` converted with nothing before it: how the track renders when its spec is read cleanly.
    fn converted_alone(path: &Path, channels: u16, rate: u32) -> Vec<f32> {
        drain(UniformSourceIterator::<_, f32>::new(
            src(path),
            channels,
            rate,
        ))
    }

    // The queue reads its first block at its idle spec, so the outgoing track is measured through the
    // same queue on its own rather than assumed to be the raw samples. Frame counts that are not a
    // multiple of the ramp period make a shifted boundary change the content, not only the length.
    #[test]
    fn a_same_spec_boundary_keeps_every_sample() {
        let dir = TempDir::new("boundary_same");
        let (a, b) = (dir.path.join("a.wav"), dir.path.join("b.wav"));
        write_wav(&a, 44_100, 2, 5_123);
        write_wav(&b, 44_100, 2, 7_077);

        // At the tracks' own spec the converter is a pass-through, so a clean boundary is the second
        // track's samples straight after the first.
        let lead = through_queue(vec![src(&a)], 2, 44_100);
        let pair = through_queue(vec![src(&a), src(&b)], 2, 44_100);
        let tail = raw_samples(&b);
        assert_eq!(pair.len(), lead.len() + tail.len());
        assert_eq!(bits(&pair[..lead.len()]), bits(&lead));
        assert_eq!(bits(&pair[lead.len()..]), bits(&tail));
    }

    #[test]
    fn a_spec_changing_boundary_misreads_the_incoming_track() {
        let dir = TempDir::new("boundary_spec");
        let (a, b) = (dir.path.join("a.wav"), dir.path.join("b.wav"));
        write_wav(&a, 44_100, 2, 5_123);
        write_wav(&b, 48_000, 1, 7_077);

        // The queue reports the outgoing spec until it pulls the next source, so the converter reads
        // the incoming track's first block as 44.1 kHz stereo. That is why such a boundary is played
        // cold rather than queued.
        for (channels, rate) in [(2u16, 48_000u32), (2, 44_100)] {
            let lead = through_queue(vec![src(&a)], channels, rate);
            let pair = through_queue(vec![src(&a), src(&b)], channels, rate);
            let clean = converted_alone(&b, channels, rate);
            assert_eq!(bits(&pair[..lead.len()]), bits(&lead));
            let tail = &pair[lead.len()..];
            assert!(
                tail.len() < clean.len(),
                "{channels}ch {rate}: the incoming track loses samples, {} vs {}",
                tail.len(),
                clean.len()
            );
            assert_ne!(bits(&tail[..64]), bits(&clean[..64]));
        }
    }

    #[test]
    fn a_queued_source_takes_over_with_the_sink_still_busy() {
        let dir = TempDir::new("boundary_sink");
        let (a, b) = (dir.path.join("a.wav"), dir.path.join("b.wav"));
        write_wav(&a, 44_100, 2, 5_123);
        write_wav(&b, 44_100, 2, 7_077);
        let lead = through_queue(vec![src(&a)], 2, 44_100);
        let tail = raw_samples(&b);

        // The sink's own wrapping of each source, as the engine appends it.
        let (sink, output) = rodio::Sink::new_idle();
        let (first, second) = (src(&a), src(&b));
        let (a_ended, b_frames, b_ended) = (
            Arc::clone(&first.ended),
            Arc::clone(&second.frames),
            Arc::clone(&second.ended),
        );
        sink.append(first);
        sink.append(second);

        let mut out = UniformSourceIterator::<_, f32>::new(output, 2, 44_100);
        let mut got = Vec::new();
        while !a_ended.load(Ordering::Relaxed) {
            got.push(out.next().expect("the keep-alive queue never ends"));
        }
        // The pull that drains the first source returns the second one's first sample.
        assert_eq!(got.len(), lead.len() + 1);
        assert_eq!(b_frames.load(Ordering::Relaxed), 0);
        assert_eq!(sink.len(), 1, "the sink stays busy, so no cold end fires");

        while !b_ended.load(Ordering::Relaxed) {
            got.push(out.next().expect("the keep-alive queue never ends"));
        }
        assert!(sink.empty());
        // The ending pull already returns the keep-alive silence.
        assert_eq!(got.pop(), Some(0.0));
        assert_eq!(bits(&got[..lead.len()]), bits(&lead));
        assert_eq!(bits(&got[lead.len()..]), bits(&tail));
    }

    #[test]
    fn a_cancelled_source_yields_nothing() {
        let dir = TempDir::new("cancel");
        let (a, b) = (dir.path.join("a.wav"), dir.path.join("b.wav"));
        write_wav(&a, 44_100, 2, 5_123);
        write_wav(&b, 44_100, 2, 7_077);
        let lead = through_queue(vec![src(&a)], 2, 44_100);

        let mut alone = src(&b);
        alone.cancel.store(true, Ordering::Relaxed);
        assert_eq!(alone.next(), None);
        assert!(!alone.ended.load(Ordering::Relaxed));

        // Cancelled while queued behind a playing track: the sink empties the moment the first track
        // drains, and nothing of the cancelled one is heard.
        let (sink, output) = rodio::Sink::new_idle();
        let (first, second) = (src(&a), src(&b));
        let cancel = Arc::clone(&second.cancel);
        sink.append(first);
        sink.append(second);
        cancel.store(true, Ordering::Relaxed);

        let mut out = UniformSourceIterator::<_, f32>::new(output, 2, 44_100);
        let got = drain(out.by_ref().take(lead.len()));
        assert_eq!(bits(&got), bits(&lead));
        assert_eq!(out.next(), Some(0.0));
        assert!(sink.empty());
    }
}
