/*
 * The shared, framework-free audio core. Two consumers lean on it at two drain rates: the realtime
 * player pulls packets incrementally as it plays, and the splicer drains a whole file to compute
 * waveform peaks and silence spans. Only `decode` touches symphonia; `peaks` and `silence` are pure
 * functions over interleaved f32 PCM, so they test on synthetic buffers with no decoder and no device.
 */

// The realtime player engine and the splicer commands are the callers of this core; neither is wired
// into the crate yet, so its public surface and convenience re-exports have no in-crate use. Allow it
// across the module rather than mark each item, and drop this once a consumer lands.
#![allow(dead_code, unused_imports)]

// -- Module Declarations --
pub mod decode;
pub mod peaks;
pub mod silence;

// -- Re-exports --
pub use decode::{DecodeError, Decoder};
pub use peaks::{compute_peaks, Peak};
pub use silence::{find_silence, SilenceSpan};

/// The sample format of a decoded stream: the rate in Hz and the interleaved channel count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioSpec {
    pub sample_rate: u32,
    pub channels: u16,
}

/// One decoded block: interleaved f32 samples in [-1.0, 1.0] and the spec they carry. Interleaved
/// means frame N occupies `samples[N * channels .. (N + 1) * channels]`.
#[derive(Clone, Debug)]
pub struct PcmChunk {
    pub samples: Vec<f32>,
    pub spec: AudioSpec,
}

impl PcmChunk {
    /// The number of frames in this chunk: one frame is one sample per channel. Zero channels reads
    /// as zero frames rather than dividing by zero.
    pub fn frames(&self) -> usize {
        self.samples
            .len()
            .checked_div(self.spec.channels as usize)
            .unwrap_or(0)
    }
}

/// Collapses interleaved samples to one mono track by averaging each frame's channels. The shared
/// downmix behind both analysis passes, so a stereo file's peaks and silence read the same signal.
/// Zero channels or empty input yields an empty track.
pub(crate) fn downmix_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    let channels = channels as usize;
    if channels == 0 || samples.is_empty() {
        return Vec::new();
    }
    if channels == 1 {
        return samples.to_vec();
    }
    let frames = samples.len() / channels;
    let mut mono = Vec::with_capacity(frames);
    for frame in 0..frames {
        let base = frame * channels;
        let sum: f32 = samples[base..base + channels].iter().sum();
        mono.push(sum / channels as f32);
    }
    mono
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_divides_samples_by_channels() {
        let chunk = PcmChunk {
            samples: vec![0.0; 8],
            spec: AudioSpec {
                sample_rate: 44_100,
                channels: 2,
            },
        };
        assert_eq!(chunk.frames(), 4);
    }

    #[test]
    fn frames_with_zero_channels_is_zero() {
        let chunk = PcmChunk {
            samples: vec![0.0; 8],
            spec: AudioSpec {
                sample_rate: 44_100,
                channels: 0,
            },
        };
        assert_eq!(chunk.frames(), 0);
    }

    #[test]
    fn downmix_averages_stereo_frames() {
        // Two frames of L/R: (1.0, -1.0) averages to 0.0, (0.5, 0.5) stays 0.5.
        let mono = downmix_mono(&[1.0, -1.0, 0.5, 0.5], 2);
        assert_eq!(mono, vec![0.0, 0.5]);
    }

    #[test]
    fn downmix_mono_passes_through() {
        let mono = downmix_mono(&[0.1, 0.2, 0.3], 1);
        assert_eq!(mono, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn downmix_empty_or_zero_channels_is_empty() {
        assert!(downmix_mono(&[], 2).is_empty());
        assert!(downmix_mono(&[1.0, 2.0], 0).is_empty());
    }
}
