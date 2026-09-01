/*
 * The one module that owns symphonia. It turns a file path into a pull-based PCM stream: the caller
 * asks for the next packet and gets interleaved f32 in [-1, 1], whatever the source sample format.
 * A pull API is what lets one decoder feed two consumers at two drain rates - the player pulls a
 * packet at a time as it plays, the splicer drains the whole file for peaks and silence. No playback
 * type leaks in here, so the splicer never inherits a playback dependency. Symphonia decodes every
 * container codec it implements; Opus is the one exception it demuxes but cannot decode, so opus-rs
 * takes those packets. The backend split is invisible past next_packet: both yield the same PcmChunk.
 */

// -- Library Imports --
use std::fs::File;
use std::path::Path;

use opus_rs::OpusDecoder;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder as SymphoniaDecoder, DecoderOptions, CODEC_TYPE_OPUS};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};

// -- Local Imports --
use super::{AudioSpec, PcmChunk};

/// Why a file could not be opened or decoded. `Unsupported` is a codec no backend decodes (or Opus
/// beyond two channels); `Open` is a probe or container failure; `Decode` is a mid-stream or seek
/// failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Unsupported,
    Open,
    Decode,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            DecodeError::Unsupported => "format is not supported",
            DecodeError::Open => "could not open the audio file",
            DecodeError::Decode => "could not decode the audio stream",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for DecodeError {}

/// The decode backend for the open track. Only the per-packet decode step branches on it: symphonia
/// covers every container codec it implements, and opus-rs decodes the Ogg-Opus packets symphonia
/// demuxes but ships no decoder for.
enum Backend {
    Symphonia(Box<dyn SymphoniaDecoder>),
    Opus(OpusBackend),
}

/// The opus-rs decode state for one Opus track. `out` is the reused interleaved f32 target, sized for
/// the largest Opus frame. `skip` is the count of leading per-channel frames still to drop from the
/// front: the OpusHead pre-skip at open, then a fresh pre-roll after each seek.
struct OpusBackend {
    dec: OpusDecoder,
    channels: usize,
    out: Vec<f32>,
    skip: u32,
}

/// Largest Opus frame in samples per channel: 120 ms at 48 kHz.
const MAX_OPUS_FRAME: usize = 5760;

/// The pre-roll a freshly built Opus decoder needs to reconverge after a seek, dropped from the front
/// of the first post-seek packets: 80 ms at 48 kHz. Distinct from the OpusHead pre-skip.
const OPUS_SEEK_PREROLL: u32 = 3840;

/// A pull-based decoder over one audio file. Built by `open`; drained by `next_packet` until it
/// returns None at end of stream. `spec` and the duration hints come from the container up front,
/// and `seek` repositions to a coarse boundary the caller can refine.
pub struct Decoder {
    format: Box<dyn FormatReader>,
    backend: Backend,
    track_id: u32,
    spec: AudioSpec,
    total_frames: Option<u64>,
    time_base: Option<TimeBase>,
    // Reused across packets to avoid reallocating the interleaved f32 scratch each call. Rebuilt only
    // when a packet reports a different rate or channel layout, which is rare mid-stream. Symphonia
    // only; the Opus backend owns its own interleaved target.
    sample_buf: Option<SampleBuffer<f32>>,
    buf_rate: u32,
    buf_channels: usize,
}

impl Decoder {
    /// Probes `path`, selects its default audio track, and builds the matching decode backend. An
    /// Opus track routes to opus-rs (refused as `Unsupported` beyond two channels); every other codec
    /// goes to symphonia. A container or codec symphonia cannot handle returns `Unsupported`; anything
    /// else that fails to open returns `Open`.
    pub fn open(path: &Path) -> Result<Decoder, DecodeError> {
        let file = File::open(path).map_err(|_| DecodeError::Open)?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        // Seed the probe with the extension so a raw stream with no container magic still routes.
        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(ext);
        }

        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(map_open_error)?;

        let format = probed.format;
        let track = format
            .default_track()
            .ok_or(DecodeError::Open)?;

        let track_id = track.id;
        let params = &track.codec_params;
        let total_frames = params.n_frames;
        let time_base = params.time_base;

        // Opus rides its own decoder: symphonia demuxes the Ogg-Opus packets but ships no Opus decoder,
        // so opus-rs takes the packet bytes. Opus always yields 48 kHz PCM, so the spec is fixed here;
        // the container's rate hint is the granule clock, not the decoded rate.
        let (backend, spec) = if params.codec == CODEC_TYPE_OPUS {
            let channels = params.channels.map(|c| c.count()).unwrap_or(2);
            // The opus-rs decoder tops out at stereo; music never exceeds it, and multistream Opus is
            // out of scope.
            if channels == 0 || channels > 2 {
                return Err(DecodeError::Unsupported);
            }
            // OpusHead pre-skip: the encoder's priming frames, dropped from the front of the stream.
            let pre_skip = params.delay.unwrap_or(0);
            let dec = OpusDecoder::new(48_000, channels).map_err(|_| DecodeError::Open)?;
            let backend = Backend::Opus(OpusBackend {
                dec,
                channels,
                out: vec![0.0; MAX_OPUS_FRAME * channels],
                skip: pre_skip,
            });
            let spec = AudioSpec {
                sample_rate: 48_000,
                channels: channels as u16,
            };
            (backend, spec)
        } else {
            let spec = AudioSpec {
                sample_rate: params.sample_rate.unwrap_or(0),
                channels: params.channels.map(|c| c.count() as u16).unwrap_or(0),
            };
            let decoder = symphonia::default::get_codecs()
                .make(params, &DecoderOptions::default())
                .map_err(map_open_error)?;
            (Backend::Symphonia(decoder), spec)
        };

        Ok(Decoder {
            format,
            backend,
            track_id,
            spec,
            total_frames,
            time_base,
            sample_buf: None,
            buf_rate: 0,
            buf_channels: 0,
        })
    }

    /// The stream's rate and channel count as the container reports them. A container that withholds
    /// them reads as zero until the first decoded packet fills them in.
    pub fn spec(&self) -> AudioSpec {
        self.spec
    }

    /// The total frame count when the container states it, else None. One frame is one sample per
    /// channel, so this is the seek/scrub extent, not a byte or packet count.
    pub fn total_frames(&self) -> Option<u64> {
        self.total_frames
    }

    /// The stream duration in seconds from the container's frame count, preferring the track's own
    /// time base and falling back to frames over sample rate. None when the container states neither.
    pub fn duration_secs(&self) -> Option<f64> {
        let frames = self.total_frames?;
        if let Some(tb) = self.time_base {
            let t = tb.calc_time(frames);
            return Some(t.seconds as f64 + t.frac);
        }
        if self.spec.sample_rate > 0 {
            return Some(frames as f64 / self.spec.sample_rate as f64);
        }
        None
    }

    /// Decodes and returns the next block of interleaved f32 samples, or None at clean end of stream.
    /// Packets belonging to other tracks are skipped, and a single corrupt packet is skipped rather
    /// than ending the stream, so one bad frame in the middle does not truncate playback.
    pub fn next_packet(&mut self) -> Option<PcmChunk> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                // A clean end of stream and any read failure both end the pull; the caller treats
                // None as done.
                Err(_) => return None,
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            match &mut self.backend {
                Backend::Symphonia(decoder) => match decoder.decode(&packet) {
                    Ok(decoded) => {
                        let signal_spec = *decoded.spec();
                        let rate = signal_spec.rate;
                        let channels = signal_spec.channels.count();

                        // Rebuild the scratch buffer on the first packet or whenever the layout shifts.
                        if self.sample_buf.is_none()
                            || self.buf_rate != rate
                            || self.buf_channels != channels
                        {
                            let capacity = decoded.capacity() as u64;
                            self.sample_buf = Some(SampleBuffer::<f32>::new(capacity, signal_spec));
                            self.buf_rate = rate;
                            self.buf_channels = channels;
                        }

                        let buf = self.sample_buf.as_mut()?;
                        buf.copy_interleaved_ref(decoded);

                        self.spec = AudioSpec {
                            sample_rate: rate,
                            channels: channels as u16,
                        };
                        return Some(PcmChunk {
                            samples: buf.samples().to_vec(),
                            spec: self.spec,
                        });
                    }
                    // A decode error on one packet is recoverable: skip it and pull the next.
                    Err(SymphoniaError::DecodeError(_)) => continue,
                    // Anything else (a reset demand, an I/O failure) ends the stream cleanly.
                    Err(_) => return None,
                },
                Backend::Opus(ob) => match ob.dec.decode(&packet.data, MAX_OPUS_FRAME, &mut ob.out) {
                    Ok(spc) => {
                        // Drop any leading pre-skip/pre-roll frames from the front before yielding.
                        let mut frames = spc;
                        let mut start = 0;
                        if ob.skip > 0 {
                            let drop = (ob.skip as usize).min(frames);
                            start = drop * ob.channels;
                            frames -= drop;
                            ob.skip -= drop as u32;
                        }
                        if frames == 0 {
                            continue;
                        }
                        return Some(PcmChunk {
                            samples: ob.out[start..start + frames * ob.channels].to_vec(),
                            spec: self.spec,
                        });
                    }
                    // A corrupt Opus packet is recoverable: skip it and pull the next.
                    Err(_) => continue,
                },
            }
        }
    }

    /// Seeks to the packet at or before `secs`. Coarse by design: the nearest packet boundary is
    /// enough for the player to then refine by decoding forward. Clears the decoder so no stale state
    /// bleeds across the jump - symphonia resets in place, the Opus decoder is rebuilt.
    pub fn seek(&mut self, secs: f64) -> Result<(), DecodeError> {
        let time = Time::from(secs.max(0.0));
        self.format
            .seek(
                SeekMode::Coarse,
                SeekTo::Time {
                    time,
                    track_id: Some(self.track_id),
                },
            )
            .map_err(|_| DecodeError::Decode)?;
        match &mut self.backend {
            // Reset clears the symphonia decoder so no stale state bleeds across the jump.
            Backend::Symphonia(decoder) => decoder.reset(),
            // No public reset on the opus-rs decoder, so rebuild it (heap-backed, about a kilobyte)
            // and arm a fresh pre-roll to reconverge past the seek point.
            Backend::Opus(ob) => {
                ob.dec = OpusDecoder::new(48_000, ob.channels).map_err(|_| DecodeError::Open)?;
                ob.skip = OPUS_SEEK_PREROLL;
            }
        }
        Ok(())
    }
}

/// Maps a symphonia open/build failure to the coarse error the app surfaces: a format or codec
/// symphonia does not implement is `Unsupported`, everything else is `Open`.
fn map_open_error(err: SymphoniaError) -> DecodeError {
    match err {
        SymphoniaError::Unsupported(_) => DecodeError::Unsupported,
        _ => DecodeError::Open,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

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
                "plisto_audio_{tag}_{}_{n}_{nanos}",
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

    // A canonical 16-bit PCM WAV: the 44-byte header plus interleaved little-endian i16 frames. The
    // samples ramp across the buffer so the decoded f32 is a known, in-range signal, not just zeros.
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
            // A triangle ramp between the rails, so every channel carries a clearly non-zero signal.
            let phase = (frame % 200) as i32 - 100; // -100..100
            let sample = (phase * 300) as i16; // -30000..30000, inside i16 range
            for _ in 0..channels {
                v.extend_from_slice(&sample.to_le_bytes());
            }
        }

        fs::write(path, v).unwrap();
    }

    #[test]
    fn decodes_a_synthetic_wav_end_to_end() {
        let dir = TempDir::new("wav");
        let path = dir.path.join("tone.wav");
        let rate = 44_100;
        let channels = 2u16;
        let frames = 4_096;
        write_wav(&path, rate, channels, frames);

        let mut decoder = Decoder::open(&path).expect("opens the WAV");
        assert_eq!(
            decoder.spec(),
            AudioSpec {
                sample_rate: rate,
                channels,
            }
        );
        // A canonical WAV states its length, so the duration hint resolves.
        assert_eq!(decoder.total_frames(), Some(frames as u64));

        let mut total_frames = 0usize;
        while let Some(chunk) = decoder.next_packet() {
            assert_eq!(chunk.spec.sample_rate, rate);
            assert_eq!(chunk.spec.channels, channels);
            for &s in &chunk.samples {
                assert!((-1.0..=1.0).contains(&s), "sample {s} out of range");
            }
            total_frames += chunk.frames();
        }

        assert_eq!(total_frames, frames, "the pull loop drains every frame");
    }

    #[test]
    fn a_mono_wav_reports_one_channel() {
        let dir = TempDir::new("mono");
        let path = dir.path.join("mono.wav");
        write_wav(&path, 22_050, 1, 1_000);

        let decoder = Decoder::open(&path).expect("opens the mono WAV");
        assert_eq!(
            decoder.spec(),
            AudioSpec {
                sample_rate: 22_050,
                channels: 1,
            }
        );
    }

    #[test]
    fn a_dot_opus_path_is_not_refused_by_extension() {
        // Opus plays now, so the extension no longer short-circuits. A missing .opus falls through to
        // the file open and reads as Open, not the old deferred-format Unsupported.
        let missing = Path::new("does_not_exist.opus");
        assert_eq!(Decoder::open(missing).err(), Some(DecodeError::Open));
    }

    // Encodes a synthetic 48 kHz tone frame by frame with opus-rs, then decodes each packet back,
    // checking the sample counts and range. No external file: it exercises the opus-rs linkage and the
    // buffer/channel math the Opus backend relies on.
    fn opus_round_trip(channels: usize) {
        use opus_rs::{Application, OpusEncoder};

        let rate = 48_000i32;
        let frame_size = 960usize; // 20 ms at 48 kHz
        let mut enc = OpusEncoder::new(rate, channels, Application::Audio).expect("builds the encoder");
        let mut dec = OpusDecoder::new(rate, channels).expect("builds the decoder");

        let mut packet = vec![0u8; 4000];
        let mut out = vec![0.0f32; MAX_OPUS_FRAME * channels];

        for frame in 0..10usize {
            let mut input = vec![0.0f32; frame_size * channels];
            for i in 0..frame_size {
                let n = (frame * frame_size + i) as f32;
                let s = (n * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5;
                for ch in 0..channels {
                    input[i * channels + ch] = s;
                }
            }
            let bytes = enc
                .encode(&input, frame_size, &mut packet)
                .expect("encodes a frame");
            let decoded = dec
                .decode(&packet[..bytes], MAX_OPUS_FRAME, &mut out)
                .expect("decodes a frame");
            // One packet decodes back to exactly one frame's worth of samples per channel.
            assert_eq!(decoded, frame_size, "decoded {decoded} samples, expected {frame_size}");
            for &s in &out[..decoded * channels] {
                assert!((-1.0..=1.0).contains(&s), "sample {s} out of range");
            }
        }
    }

    #[test]
    fn opus_round_trips_mono() {
        opus_round_trip(1);
    }

    #[test]
    fn opus_round_trips_stereo() {
        opus_round_trip(2);
    }

    #[test]
    fn a_missing_file_fails_to_open() {
        let dir = TempDir::new("missing");
        let path = dir.path.join("nope.wav");
        assert_eq!(Decoder::open(&path).err(), Some(DecodeError::Open));
    }

    #[test]
    fn garbage_bytes_do_not_open() {
        let dir = TempDir::new("garbage");
        let path = dir.path.join("junk.wav");
        fs::write(&path, b"not a real audio file at all").unwrap();
        // A non-audio payload fails the probe; the exact variant is coarse, only that it is an Err.
        assert!(Decoder::open(&path).is_err());
    }
}
