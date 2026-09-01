/*
 * Waveform reduction: interleaved f32 PCM down to a fixed number of min/max buckets for drawing.
 * Pure and framework-free - no symphonia, no decoder - so it tests on synthetic buffers. `compute_peaks`
 * reduces a whole mono buffer at once; `PeakAccumulator` folds the same reduction one frame at a time,
 * so a streaming decode of a long file never holds more than the buckets it is building.
 */

// -- Library Imports --
use serde::Serialize;

// -- Local Imports --
use super::downmix_mono;

/// The vertical extent of one waveform bucket: the lowest and highest mono sample it spans. A silent
/// bucket reads min == max == 0.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Peak {
    pub min: f32,
    pub max: f32,
}

/// One fine peak per this many frames on the unknown-length path, downsampled to the bucket count at
/// the end. Fine enough that the final downsample never visibly coarsens the drawing.
const FINE_FRAMES: u64 = 1024;

/// Folds mono frames into `buckets` min/max pairs one sample at a time, so a whole-file reduction
/// never buffers more than its output. With a known total the frames fall onto their bucket through a
/// monotonic cursor (O(buckets) memory); with no total up front the samples accumulate at a fixed
/// fine resolution and downsample to `buckets` at `finish` (O(frames / FINE_FRAMES)).
pub struct PeakAccumulator {
    buckets: usize,
    total: Option<u64>,
    // Running min/max of the bucket currently being built.
    cur_min: f32,
    cur_max: f32,
    cur_has: bool,
    // Known-total path: the completed buckets, the frame cursor, and the current bucket's end frame.
    out: Vec<Peak>,
    frame_index: u64,
    cur_bucket: usize,
    cur_end: u64,
    // Unknown-total path: the fine buckets and the frame count within the one being built.
    fine: Vec<Peak>,
    fine_count: u64,
}

impl PeakAccumulator {
    /// A fresh accumulator for `buckets` output peaks. `total_frames` picks the path: `Some` folds
    /// straight into the buckets, `None` accumulates fine and downsamples at `finish`.
    pub fn new(buckets: usize, total_frames: Option<u64>) -> Self {
        let cur_end = match total_frames {
            Some(total) if buckets > 0 => total / buckets as u64,
            _ => 0,
        };
        Self {
            buckets,
            total: total_frames,
            cur_min: 0.0,
            cur_max: 0.0,
            cur_has: false,
            out: Vec::new(),
            frame_index: 0,
            cur_bucket: 0,
            cur_end,
            fine: Vec::new(),
            fine_count: 0,
        }
    }

    /// Folds one mono sample into the reduction.
    pub fn push_mono(&mut self, v: f32) {
        if self.buckets == 0 {
            return;
        }
        match self.total {
            Some(total) => self.push_known(v, total),
            None => self.push_fine(v),
        }
    }

    /// Reduces to exactly `buckets` peaks. A bucket that lands on no frames (more buckets than frames)
    /// reads as a flat zero peak, so the length always equals `buckets`.
    pub fn finish(mut self) -> Vec<Peak> {
        if self.buckets == 0 {
            return Vec::new();
        }
        match self.total {
            Some(_) => {
                // Close the current bucket and pad any remaining ones to flat zero.
                while self.cur_bucket < self.buckets {
                    let peak = self.take_current();
                    self.out.push(peak);
                    self.cur_bucket += 1;
                }
                self.out
            }
            None => {
                if self.cur_has {
                    let peak = self.take_current();
                    self.fine.push(peak);
                }
                reduce(&self.fine, self.buckets)
            }
        }
    }

    /// The known-total fold: close each bucket whose range ends at or before the cursor, padding empty
    /// ranges with a flat zero, then fold the sample into the live bucket.
    fn push_known(&mut self, v: f32, total: u64) {
        while self.frame_index >= self.cur_end && self.cur_bucket < self.buckets {
            let peak = self.take_current();
            self.out.push(peak);
            self.cur_bucket += 1;
            self.cur_end = (self.cur_bucket as u64 + 1) * total / self.buckets as u64;
        }
        if self.cur_bucket < self.buckets {
            self.fold(v);
            self.frame_index += 1;
        }
    }

    /// The unknown-total fold: accumulate into a fixed-size fine bucket, emitting one every
    /// `FINE_FRAMES` frames.
    fn push_fine(&mut self, v: f32) {
        self.fold(v);
        self.fine_count += 1;
        if self.fine_count >= FINE_FRAMES {
            let peak = self.take_current();
            self.fine.push(peak);
            self.fine_count = 0;
        }
    }

    /// Extends the live bucket's running min/max with one sample.
    fn fold(&mut self, v: f32) {
        if self.cur_has {
            if v < self.cur_min {
                self.cur_min = v;
            }
            if v > self.cur_max {
                self.cur_max = v;
            }
        } else {
            self.cur_min = v;
            self.cur_max = v;
            self.cur_has = true;
        }
    }

    /// Emits the live bucket's peak (a flat zero when it saw no frames) and resets the running state.
    fn take_current(&mut self) -> Peak {
        let peak = if self.cur_has {
            Peak {
                min: self.cur_min,
                max: self.cur_max,
            }
        } else {
            Peak { min: 0.0, max: 0.0 }
        };
        self.cur_min = 0.0;
        self.cur_max = 0.0;
        self.cur_has = false;
        peak
    }
}

/// Reduces interleaved `samples` to `buckets` min/max pairs over the mono downmix. Empty input or
/// `buckets == 0` yields an empty vec; otherwise the output length always equals `buckets`. Feeds a
/// `PeakAccumulator` with the known frame count, so the batch and streaming paths reduce identically.
pub fn compute_peaks(samples: &[f32], channels: u16, buckets: usize) -> Vec<Peak> {
    if buckets == 0 {
        return Vec::new();
    }
    let mono = downmix_mono(samples, channels);
    if mono.is_empty() {
        return Vec::new();
    }
    let mut acc = PeakAccumulator::new(buckets, Some(mono.len() as u64));
    for &v in &mono {
        acc.push_mono(v);
    }
    acc.finish()
}

/// Downsamples fine peaks to `buckets` by the same even split `compute_peaks` uses over raw frames,
/// taking the lowest min and highest max across each range. Empty input yields `buckets` flat zeros.
fn reduce(fine: &[Peak], buckets: usize) -> Vec<Peak> {
    let n = fine.len();
    let mut out = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let start = b * n / buckets;
        let end = (b + 1) * n / buckets;
        let slice = &fine[start..end];

        let mut min = 0.0f32;
        let mut max = 0.0f32;
        if let Some((first, rest)) = slice.split_first() {
            min = first.min;
            max = first.max;
            for p in rest {
                if p.min < min {
                    min = p.min;
                }
                if p.max > max {
                    max = p.max;
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

    #[test]
    fn streaming_known_total_matches_the_batch() {
        // The same mono signal, fed one frame at a time into a known-total accumulator, reduces to the
        // exact same buckets the batch function produces. This is the path the file analysis walks.
        let samples = sine(4099, 41.0);
        let batch = compute_peaks(&samples, 1, 37);

        let mut acc = PeakAccumulator::new(37, Some(samples.len() as u64));
        for &v in &samples {
            acc.push_mono(v);
        }
        assert_eq!(
            acc.finish(),
            batch,
            "streaming and batch agree bucket for bucket"
        );
    }

    #[test]
    fn streaming_unknown_total_matches_length_and_reads_the_signal() {
        // With no length up front the accumulator downsamples its fine buffer, still yielding exactly
        // `buckets` peaks that reach the rails of a full-scale signal. The frame count stays well above
        // buckets x FINE_FRAMES so every bucket lands on real fine data.
        let samples = sine(40_000, 400.0);
        let mut acc = PeakAccumulator::new(20, None);
        for &v in &samples {
            acc.push_mono(v);
        }
        let peaks = acc.finish();
        assert_eq!(peaks.len(), 20);
        for p in &peaks {
            assert!(p.max > 0.9, "max near +1, got {}", p.max);
            assert!(p.min < -0.9, "min near -1, got {}", p.min);
        }
    }

    #[test]
    fn unknown_total_silence_is_flat_zero() {
        let mut acc = PeakAccumulator::new(12, None);
        for _ in 0..5000 {
            acc.push_mono(0.0);
        }
        let peaks = acc.finish();
        assert_eq!(peaks.len(), 12);
        for p in &peaks {
            assert_eq!(p.min, 0.0);
            assert_eq!(p.max, 0.0);
        }
    }
}
