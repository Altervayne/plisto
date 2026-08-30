/*
 * Waveform reduction: interleaved f32 PCM down to a fixed number of min/max buckets for drawing.
 * Pure and framework-free - no symphonia, no decoder - so it tests on synthetic buffers. The splicer
 * decodes a whole file to a Vec and reduces it here; the count of buckets is the on-screen resolution.
 */

// -- Local Imports --
use super::downmix_mono;

/// The vertical extent of one waveform bucket: the lowest and highest mono sample it spans. A silent
/// bucket reads min == max == 0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Peak {
    pub min: f32,
    pub max: f32,
}

/// Reduces interleaved `samples` to `buckets` min/max pairs over the mono downmix. The frame stream
/// splits into `buckets` even ranges and each range collapses to its min and max. Empty input or
/// `buckets == 0` yields an empty vec; a bucket that lands on no frames (more buckets than frames)
/// reads as a flat zero peak, so the output length always equals `buckets` for non-empty input.
pub fn compute_peaks(samples: &[f32], channels: u16, buckets: usize) -> Vec<Peak> {
    if buckets == 0 {
        return Vec::new();
    }
    let mono = downmix_mono(samples, channels);
    let frames = mono.len();
    if frames == 0 {
        return Vec::new();
    }

    let mut out = Vec::with_capacity(buckets);
    for b in 0..buckets {
        // Even split by integer scaling: bucket b spans frames [b*frames/buckets, (b+1)*frames/buckets).
        // Uneven remainders spread across buckets rather than piling onto the last one.
        let start = b * frames / buckets;
        let end = (b + 1) * frames / buckets;
        let slice = &mono[start..end];

        let mut min = 0.0f32;
        let mut max = 0.0f32;
        if let Some((&first, rest)) = slice.split_first() {
            min = first;
            max = first;
            for &s in rest {
                if s < min {
                    min = s;
                }
                if s > max {
                    max = s;
                }
            }
        }
        out.push(Peak { min, max });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    // A mono full-scale sine over `frames` samples at the given cycles-per-buffer.
    fn sine(frames: usize, cycles: f32) -> Vec<f32> {
        (0..frames)
            .map(|i| (2.0 * PI * cycles * i as f32 / frames as f32).sin())
            .collect()
    }

    #[test]
    fn full_scale_sine_fills_buckets_to_the_rails() {
        let samples = sine(4096, 64.0);
        let peaks = compute_peaks(&samples, 1, 32);
        assert_eq!(peaks.len(), 32);
        // Each bucket holds many cycles, so it very nearly reaches both rails.
        for p in &peaks {
            assert!(p.max > 0.99, "max near +1, got {}", p.max);
            assert!(p.min < -0.99, "min near -1, got {}", p.min);
        }
    }

    #[test]
    fn silent_buffer_is_flat_zero() {
        let peaks = compute_peaks(&[0.0; 1000], 1, 16);
        assert_eq!(peaks.len(), 16);
        for p in &peaks {
            assert_eq!(p.min, 0.0);
            assert_eq!(p.max, 0.0);
        }
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(compute_peaks(&[], 2, 16).is_empty());
    }

    #[test]
    fn zero_buckets_is_empty() {
        assert!(compute_peaks(&[0.1, 0.2, 0.3], 1, 0).is_empty());
    }

    #[test]
    fn a_ramp_yields_monotone_buckets() {
        // A 0..1 ramp: each later bucket covers higher sample values than the one before it, so both
        // the min and max climb monotonically across buckets.
        let frames = 1000;
        let ramp: Vec<f32> = (0..frames).map(|i| i as f32 / frames as f32).collect();
        let peaks = compute_peaks(&ramp, 1, 10);
        assert_eq!(peaks.len(), 10);
        for pair in peaks.windows(2) {
            assert!(pair[1].min > pair[0].min, "mins climb across buckets");
            assert!(pair[1].max > pair[0].max, "maxs climb across buckets");
        }
    }

    #[test]
    fn stereo_downmix_averages_before_bucketing() {
        // L is +1 everywhere, R is -1 everywhere: the mono downmix is 0, so every bucket is flat.
        let mut samples = Vec::new();
        for _ in 0..500 {
            samples.push(1.0);
            samples.push(-1.0);
        }
        let peaks = compute_peaks(&samples, 2, 8);
        assert_eq!(peaks.len(), 8);
        for p in &peaks {
            assert!(p.max.abs() < 1e-6 && p.min.abs() < 1e-6);
        }
    }

    #[test]
    fn more_buckets_than_frames_pads_with_flat_zero() {
        // Four frames into eight buckets: the empty ranges read as flat zero, length still matches.
        let peaks = compute_peaks(&[0.5, 0.6, 0.7, 0.8], 1, 8);
        assert_eq!(peaks.len(), 8);
    }
}
