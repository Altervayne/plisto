/*
 * The one module that owns symphonia. It turns a file path into a pull-based PCM stream: the caller
 * asks for the next packet and gets interleaved f32 in [-1, 1], whatever the source sample format.
 * A pull API is what lets one decoder feed two consumers at two drain rates - the player pulls a
 * packet at a time as it plays, the splicer drains the whole file for peaks and silence. No playback
 * type leaks in here, so the splicer never inherits a playback dependency. Opus is deferred: symphonia
 * ships no production Opus decoder, so an Opus track or a .opus file is refused up front.
 */

// -- Library Imports --
use std::fs::File;
use std::path::Path;

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

/// Why a file could not be opened or decoded. `Unsupported` is the deferred-format case (Opus);
/// `Open` is a probe or container failure; `Decode` is a mid-stream or seek failure.
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

/// A pull-based decoder over one audio file. Built by `open`; drained by `next_packet` until it
/// returns None at end of stream. `spec` and the duration hints come from the container up front,
/// and `seek` repositions to a coarse boundary the caller can refine.
pub struct Decoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn SymphoniaDecoder>,
    track_id: u32,
    spec: AudioSpec,
    total_frames: Option<u64>,
    time_base: Option<TimeBase>,
    // Reused across packets to avoid reallocating the interleaved f32 scratch each call. Rebuilt only
    // when a packet reports a different rate or channel layout, which is rare mid-stream.
    sample_buf: Option<SampleBuffer<f32>>,
    buf_rate: u32,
    buf_channels: usize,
}

impl Decoder {
    /// Probes `path`, selects its default audio track, and builds the matching decoder. An Opus track
    /// or a `.opus` extension returns `Unsupported` without probing further - Opus is deferred. A
    /// container or codec symphonia cannot handle returns `Unsupported`; anything else that fails to
    /// open returns `Open`.
    pub fn open(path: &Path) -> Result<Decoder, DecodeError> {
        // Refuse Opus by extension before touching the file: the decoder does not exist, and this
        // keeps the deferred-format contract identical whether or not the container probes cleanly.
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if ext.eq_ignore_ascii_case("opus") {
                return Err(DecodeError::Unsupported);
            }
        }

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

        // An Opus track inside a container symphonia can demux but not decode: refuse it as deferred,
        // not as a generic decode failure.
        if track.codec_params.codec == CODEC_TYPE_OPUS {
            return Err(DecodeError::Unsupported);
        }

        let track_id = track.id;
        let params = &track.codec_params;
        let spec = AudioSpec {
            sample_rate: params.sample_rate.unwrap_or(0),
            channels: params.channels.map(|c| c.count() as u16).unwrap_or(0),
        };
        let total_frames = params.n_frames;
        let time_base = params.time_base;

        let decoder = symphonia::default::get_codecs()
            .make(params, &DecoderOptions::default())
            .map_err(map_open_error)?;

        Ok(Decoder {
            format,
            decoder,
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

            match self.decoder.decode(&packet) {
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
            }
        }
    }

    /// Seeks to the packet at or before `secs`. Coarse by design: the nearest packet boundary is
    /// enough for the player to then refine by decoding forward. Resets the decoder so no stale
    /// state bleeds across the jump.
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
        self.decoder.reset();
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
    fn a_dot_opus_path_is_unsupported_before_any_read() {
        // The file need not exist: the extension gate refuses Opus up front.
        let missing = Path::new("does_not_exist.opus");
        assert_eq!(Decoder::open(missing).err(), Some(DecodeError::Unsupported));
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
