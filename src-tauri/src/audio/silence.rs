/*
 * Silence detection: interleaved f32 PCM down to the frame ranges that sit below a loudness
 * threshold for long enough to count. Pure and framework-free - no symphonia, no decoder - so it
 * tests on synthetic buffers. The cropper trims leading/trailing silence with it and the splicer
 * seeds auto-split points from it; both feed the same spans into one editable cut list.
 */

// -- Local Imports --
use super::{downmix_mono, AudioSpec};

// The RMS window length. Short enough to place a boundary tightly, long enough that one quiet sample
// between beats does not read as silence.
const WINDOW_SECS: f64 = 0.03;

/// A contiguous run of silence in frame units: `start_frame` inclusive, `end_frame` exclusive. One
/// frame is one sample per channel, so these map straight onto a cut position.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SilenceSpan {
    pub start_frame: u64,
    pub end_frame: u64,
}

/// Finds the silence spans in interleaved `samples`. Loudness is measured as RMS over short windows
/// of the mono downmix; a window is silent when its RMS sits below `threshold_db` relative to
/// full-scale 1.0 (so -50.0 is quiet, 0.0 is the loudest possible). Contiguous silent windows that
/// together last at least `min_silence_secs` form one span. Empty input, a zero sample rate, or no
/// qualifying run yields an empty vec.
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
    let frames = mono.len();
    if frames == 0 {
        return Vec::new();
    }

    // A window of at least one frame, and the run length a span must reach to count.
    let window = ((spec.sample_rate as f64 * WINDOW_SECS).round() as usize).max(1);
    let min_silence_frames = (min_silence_secs * spec.sample_rate as f64).round().max(0.0) as u64;

    // The linear amplitude the RMS must stay under. db = 20*log10(amp), inverted here.
    let threshold_amp = 10f32.powf(threshold_db / 20.0);

    let mut spans = Vec::new();
    let mut run_start: Option<usize> = None;

    let mut start = 0;
    while start < frames {
        let end = (start + window).min(frames);
        let slice = &mono[start..end];

        let sum_sq: f32 = slice.iter().map(|s| s * s).sum();
        let rms = (sum_sq / slice.len() as f32).sqrt();

        if rms < threshold_amp {
            // Extend the current silent run, opening one if none is live.
            run_start.get_or_insert(start);
        } else if let Some(rs) = run_start.take() {
            // A loud window closes the run; keep it only if it lasted long enough.
            push_if_long_enough(&mut spans, rs as u64, start as u64, min_silence_frames);
        }
        start = end;
    }

    // A run still open at the end of the buffer closes at the last frame.
    if let Some(rs) = run_start.take() {
        push_if_long_enough(&mut spans, rs as u64, frames as u64, min_silence_frames);
    }

    spans
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
        assert!(spans.is_empty(), "a loud sine is never silent, got {spans:?}");
    }

    #[test]
    fn loud_quiet_loud_yields_one_span_at_the_gap() {
        // Half a second loud, half a second silent, half a second loud.
        let half = RATE as usize / 2;
        let mut samples = sine(half);
        samples.extend(std::iter::repeat(0.0).take(half));
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
        samples.extend(std::iter::repeat(0.0).take(gap));
        samples.extend(sine(loud));

        let spans = find_silence(&samples, spec(1), -50.0, 0.2);
        assert!(spans.is_empty(), "a short dip is not a gap, got {spans:?}");
    }
}
