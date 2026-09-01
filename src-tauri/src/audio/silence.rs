/*
 * Silence detection: interleaved f32 PCM down to the frame ranges that sit below a loudness
 * threshold for long enough to count. Pure and framework-free - no symphonia, no decoder - so it
 * tests on synthetic buffers. `find_silence` scans a whole mono buffer; `SilenceDetector` runs the
 * same windowed rule one frame at a time, so a streaming decode never buffers the whole signal. The
 * cropper trims leading/trailing silence and the splicer seeds auto-split points from these spans.
 */

// -- Library Imports --
use serde::Serialize;

// -- Local Imports --
use super::{downmix_mono, AudioSpec};

// The RMS window length. Short enough to place a boundary tightly, long enough that one quiet sample
// between beats does not read as silence.
const WINDOW_SECS: f64 = 0.03;

/// A contiguous run of silence in frame units: `start_frame` inclusive, `end_frame` exclusive. One
/// frame is one sample per channel, so these map straight onto a cut position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SilenceSpan {
    pub start_frame: u64,
    pub end_frame: u64,
}

/// Finds the silence spans in interleaved `samples`. Loudness is measured as RMS over short windows
/// of the mono downmix; a window is silent when its RMS sits below `threshold_db` relative to
/// full-scale 1.0 (so -50.0 is quiet, 0.0 is the loudest possible). Contiguous silent windows that
/// together last at least `min_silence_secs` form one span. Empty input, a zero sample rate, or no
/// qualifying run yields an empty vec. Drives a `SilenceDetector`, so the batch and streaming paths
/// find the same spans.
pub fn find_silence(
    samples: &[f32],
    spec: AudioSpec,
    threshold_db: f32,
    min_silence_secs: f64,
) -> Vec<SilenceSpan> {
    if spec.sample_rate == 0 {
        return Vec::new();
    }
    let mono = downmix_mono(samples, spec.channels);
    if mono.is_empty() {
        return Vec::new();
    }
    let mut detector = SilenceDetector::new(spec, threshold_db, min_silence_secs);
    for &v in &mono {
        detector.push_mono(v);
    }
    detector.finish()
}

/// Runs the windowed silence rule over a stream of mono frames, one sample at a time, emitting the
/// same spans `find_silence` would over the whole buffer. A window's RMS is compared to the threshold
/// as the window fills; contiguous silent windows long enough together close into a span. Memory is
/// one window plus the spans found so far.
pub struct SilenceDetector {
    window: usize,
    min_silence_frames: u64,
    threshold_amp: f32,
    // False when the sample rate is zero: there is no time base, so nothing is detected.
    active: bool,
    // The window being filled: its running sum of squares, its sample count, and its start frame.
    win_sum_sq: f32,
    win_count: usize,
    win_start: u64,
    frame_index: u64,
    // The open silent run's start frame, or None between runs.
    run_start: Option<u64>,
    spans: Vec<SilenceSpan>,
}

impl SilenceDetector {
    /// A fresh detector for `spec`. The window length and the minimum-run length derive from the
    /// sample rate; the threshold converts from dB to a linear amplitude once.
    pub fn new(spec: AudioSpec, threshold_db: f32, min_silence_secs: f64) -> Self {
        let window = ((spec.sample_rate as f64 * WINDOW_SECS).round() as usize).max(1);
        let min_silence_frames = (min_silence_secs * spec.sample_rate as f64)
            .round()
            .max(0.0) as u64;
        let threshold_amp = 10f32.powf(threshold_db / 20.0);
        Self {
            window,
            min_silence_frames,
            threshold_amp,
            active: spec.sample_rate != 0,
            win_sum_sq: 0.0,
            win_count: 0,
            win_start: 0,
            frame_index: 0,
            run_start: None,
            spans: Vec::new(),
        }
    }

    /// Folds one mono sample into the current window, closing the window once it is full.
    pub fn push_mono(&mut self, v: f32) {
        if !self.active {
            return;
        }
        if self.win_count == 0 {
            self.win_start = self.frame_index;
        }
        self.win_sum_sq += v * v;
        self.win_count += 1;
        self.frame_index += 1;
        if self.win_count == self.window {
            self.close_window();
        }
    }

    /// Flushes the trailing partial window and closes any run still open at the final frame.
    pub fn finish(mut self) -> Vec<SilenceSpan> {
        if !self.active {
            return Vec::new();
        }
        if self.win_count > 0 {
            self.close_window();
        }
        if let Some(rs) = self.run_start.take() {
            push_if_long_enough(
                &mut self.spans,
                rs,
                self.frame_index,
                self.min_silence_frames,
            );
        }
        self.spans
    }

    /// Applies the threshold to the filled window: a silent window extends the open run, a loud one
    /// closes it (recording the span when it lasted long enough). Resets the window afterward.
    fn close_window(&mut self) {
        if is_silent(self.win_sum_sq, self.win_count, self.threshold_amp) {
            self.run_start.get_or_insert(self.win_start);
        } else if let Some(rs) = self.run_start.take() {
            push_if_long_enough(&mut self.spans, rs, self.win_start, self.min_silence_frames);
        }
        self.win_sum_sq = 0.0;
        self.win_count = 0;
    }
}

/// Whether a filled window sits below the silence threshold. An empty window reads as silent.
fn is_silent(sum_sq: f32, count: usize, threshold_amp: f32) -> bool {
    if count == 0 {
        return true;
    }
    (sum_sq / count as f32).sqrt() < threshold_amp
}

/// Records a candidate span only when it spans at least `min_frames`, so a brief dip between beats
/// never registers as a gap.
fn push_if_long_enough(spans: &mut Vec<SilenceSpan>, start: u64, end: u64, min_frames: u64) {
    if end.saturating_sub(start) >= min_frames {
        spans.push(SilenceSpan {
            start_frame: start,
            end_frame: end,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::PI;

    const RATE: u32 = 48_000;

    fn spec(channels: u16) -> AudioSpec {
        AudioSpec {
            sample_rate: RATE,
            channels,
        }
    }

    // A mono full-scale sine of `frames` samples.
    fn sine(frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| (2.0 * PI * 220.0 * i as f32 / RATE as f32).sin())
            .collect()
    }

    #[test]
    fn an_all_silent_buffer_is_one_span() {
        // One second of pure zeros: a single span covering the whole buffer.
        let samples = vec![0.0f32; RATE as usize];
        let spans = find_silence(&samples, spec(1), -50.0, 0.1);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_frame, 0);
        // The last partial window closes at the final frame.
        assert_eq!(spans[0].end_frame, RATE as u64);
    }

    #[test]
    fn a_full_scale_sine_has_no_silence() {
        let samples = sine(RATE as usize);
        let spans = find_silence(&samples, spec(1), -50.0, 0.1);
        assert!(
            spans.is_empty(),
            "a loud sine is never silent, got {spans:?}"
        );
    }

    #[test]
    fn loud_quiet_loud_yields_one_span_at_the_gap() {
        // Half a second loud, half a second silent, half a second loud.
        let half = RATE as usize / 2;
        let mut samples = sine(half);
        samples.extend(std::iter::repeat_n(0.0, half));
        samples.extend(sine(half));

        let spans = find_silence(&samples, spec(1), -50.0, 0.2);
        assert_eq!(spans.len(), 1, "exactly one gap, got {spans:?}");

        // The gap sits at the middle third, within a window's slack of the true boundaries.
        let window = (RATE as f64 * WINDOW_SECS) as u64;
        let s = spans[0];
        assert!(
            (s.start_frame as i64 - half as i64).abs() <= window as i64,
            "gap starts near frame {half}, got {}",
            s.start_frame
        );
        assert!(
            (s.end_frame as i64 - (2 * half) as i64).abs() <= window as i64,
            "gap ends near frame {}, got {}",
            2 * half,
            s.end_frame
        );
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(find_silence(&[], spec(2), -50.0, 0.1).is_empty());
    }

    #[test]
    fn zero_sample_rate_is_empty() {
        let spec = AudioSpec {
            sample_rate: 0,
            channels: 1,
        };
        assert!(find_silence(&[0.0; 1000], spec, -50.0, 0.1).is_empty());
    }

    #[test]
    fn a_gap_shorter_than_the_minimum_is_ignored() {
        // A 50 ms silent gap with a 200 ms minimum never registers.
        let loud = RATE as usize / 4;
        let gap = RATE as usize / 20;
        let mut samples = sine(loud);
        samples.extend(std::iter::repeat_n(0.0, gap));
        samples.extend(sine(loud));

        let spans = find_silence(&samples, spec(1), -50.0, 0.2);
        assert!(spans.is_empty(), "a short dip is not a gap, got {spans:?}");
    }

    #[test]
    fn streaming_detector_matches_the_batch() {
        // The same signal, fed one frame at a time into the detector, closes the same spans the batch
        // scan finds. This is the path the file analysis walks.
        let half = RATE as usize / 2;
        let mut samples = sine(half);
        samples.extend(std::iter::repeat_n(0.0, half));
        samples.extend(sine(half));

        let batch = find_silence(&samples, spec(1), -50.0, 0.2);

        let mut detector = SilenceDetector::new(spec(1), -50.0, 0.2);
        for &v in &samples {
            detector.push_mono(v);
        }
        assert_eq!(
            detector.finish(),
            batch,
            "streaming and batch find the same spans"
        );
    }
}
