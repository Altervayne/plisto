/*
 * The waveform snapshot: a short window of the playing audio, picked from the spectrum tap ring so
 * a visualizer can draw a scope. Pure over a sample reader, so it tests without a tap or a device.
 * The start is chosen at a random point among samples that arrived since the previous window,
 * nudged to the next rising zero crossing so a steady tone draws a steady trace. Successive windows
 * never overlap or touch, so stitching them cannot rebuild a longer continuous stretch of audio.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

// -- Internal Imports --
use crate::audio::queue::Xorshift;
use crate::audio::source::{SpectrumTap, SPECTRUM_RING};

/// Values in one emitted window.
pub const WAVE_LEN: usize = 256;

// Raw samples a window spans: two per emitted value.
const WINDOW: usize = WAVE_LEN * 2;
// How far past the random offset the trigger looks for a rising zero crossing.
const TRIGGER_SPAN: usize = 256;
// Below this a window counts as silence and stays all zero rather than being scaled up.
const SILENT_PEAK: f32 = 1e-9;

/// The picker for waveform windows. Off until asked, and remembers where the last window ended.
pub struct Waveform {
    on: bool,
    // The tap's write cursor when the previous window was picked; nothing before it is used again.
    last: u64,
    rng: Xorshift,
}

impl Waveform {
    pub fn new(seed: u64) -> Self {
        Self {
            on: false,
            last: 0,
            rng: Xorshift::new(seed),
        }
    }

    /// Turns the snapshot on or off. Turning it on forgets the previous window.
    pub fn set_on(&mut self, on: bool) {
        self.on = on;
        self.last = 0;
    }

    pub fn is_on(&self) -> bool {
        self.on
    }

    /// Forgets the previous window, for a tap that starts counting again from zero.
    pub fn reset(&mut self) {
        self.last = 0;
    }

    /// One window from the trailing samples of `tap`, or None while off or when too few samples are
    /// new.
    pub fn snapshot(&mut self, tap: &SpectrumTap) -> Option<Vec<f32>> {
        let written = tap.written.load(Ordering::Relaxed);
        self.window(written, |i| {
            f32::from_bits(tap.ring[(i as usize) & (SPECTRUM_RING - 1)].load(Ordering::Relaxed))
        })
    }

    /// One window over a stream that has written `written` samples, read through `sample`. The
    /// reader is only asked for samples the ring still holds. At most one window per call.
    fn window(&mut self, written: u64, sample: impl Fn(u64) -> f32) -> Option<Vec<f32>> {
        let start = self.pick(written, &sample)?;
        let raw: Vec<f32> = (0..WINDOW as u64).map(|k| sample(start + k)).collect();
        Some(scale(&raw))
    }

    /// The first raw sample of the next window, or None. The offset is drawn from the samples the
    /// ring still holds and that arrived since the last window, leaving room for the trigger span
    /// and the window itself.
    fn pick(&mut self, written: u64, sample: &impl Fn(u64) -> f32) -> Option<u64> {
        if !self.on {
            return None;
        }
        if self.last > written {
            self.last = 0;
        }
        let lo = written.saturating_sub(SPECTRUM_RING as u64).max(self.last);
        let need = (WINDOW + TRIGGER_SPAN) as u64;
        if written < lo + need {
            return None;
        }
        let room = (written - need - lo + 1) as usize;
        let offset = lo + self.rng.below(room) as u64;
        self.last = written;
        let trigger = (offset + 1..offset + TRIGGER_SPAN as u64)
            .find(|&i| sample(i - 1) < 0.0 && sample(i) >= 0.0);
        Some(trigger.unwrap_or(offset))
    }
}

/// Averages pairs down to WAVE_LEN values and scales them to their own peak. Silence stays zero.
fn scale(raw: &[f32]) -> Vec<f32> {
    let mut out: Vec<f32> = (0..WAVE_LEN).map(|k| (raw[2 * k] + raw[2 * k + 1]) * 0.5).collect();
    let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak > SILENT_PEAK {
        for v in &mut out {
            *v /= peak;
        }
    } else {
        out.fill(0.0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // A steady two-tone fixture, defined for every index.
    fn fixture(i: u64) -> f32 {
        let t = i as f32;
        0.6 * (t * 0.031).sin() + 0.3 * (t * 0.173).sin()
    }

    // Reader that fails the test when asked for a sample the ring no longer holds.
    fn ring_reader(written: u64) -> impl Fn(u64) -> f32 {
        move |i| {
            assert!(i < written, "read past the write cursor");
            assert!(i + SPECTRUM_RING as u64 >= written, "read a sample the ring dropped");
            fixture(i)
        }
    }

    fn on(seed: u64) -> Waveform {
        let mut w = Waveform::new(seed);
        w.set_on(true);
        w
    }

    #[test]
    fn the_window_has_the_emitted_length_and_stays_in_range() {
        let mut w = on(1);
        let win = w.window(2048, ring_reader(2048)).expect("a window");
        assert_eq!(win.len(), WAVE_LEN);
        assert!(win.iter().all(|v| (-1.0..=1.0).contains(v)));
    }

    #[test]
    fn the_window_is_scaled_to_a_peak_of_one() {
        let mut w = on(2);
        let win = w.window(2048, ring_reader(2048)).expect("a window");
        let peak = win.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((peak - 1.0).abs() < 1e-6);
    }

    #[test]
    fn silence_stays_all_zero() {
        let mut w = on(3);
        let win = w.window(2048, |_| 0.0).expect("a window");
        assert_eq!(win.len(), WAVE_LEN);
        assert!(win.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn no_window_while_off() {
        let mut w = Waveform::new(4);
        assert!(w.window(2048, ring_reader(2048)).is_none());
        w.set_on(true);
        assert!(w.window(2048, ring_reader(2048)).is_some());
        w.set_on(false);
        assert!(w.window(4096, ring_reader(4096)).is_none());
    }

    #[test]
    fn a_ring_too_short_for_a_window_and_the_trigger_sends_none() {
        let mut w = on(5);
        let need = (WINDOW + TRIGGER_SPAN) as u64;
        assert!(w.window(need - 1, ring_reader(need - 1)).is_none());
        assert!(w.window(need, ring_reader(need)).is_some());
    }

    #[test]
    fn the_start_is_a_rising_zero_crossing_when_one_is_in_reach() {
        let mut w = on(6);
        let written = 2048;
        let start = w.pick(written, &ring_reader(written)).expect("a start");
        assert!(fixture(start - 1) < 0.0 && fixture(start) >= 0.0);
    }

    #[test]
    fn without_a_crossing_the_offset_itself_is_used() {
        let mut w = on(7);
        let start = w.pick(4096, &|_| 0.5).expect("a start");
        assert!(start >= 4096 - SPECTRUM_RING as u64);
        assert!(start <= 4096 - (WINDOW + TRIGGER_SPAN) as u64);
    }

    // Emits every `step` samples over 30 s; returns each window's (start, end) in raw samples.
    fn run(rate: u32, step: u64, seed: u64) -> Vec<(u64, u64)> {
        let mut w = on(seed);
        let total = u64::from(rate) * 30;
        let mut spans: Vec<(u64, u64)> = Vec::new();
        let mut written = step;
        while written <= total {
            let before = w.last;
            if let Some(start) = w.pick(written, &ring_reader(written)) {
                let lo = written.saturating_sub(SPECTRUM_RING as u64).max(before);
                assert!(start >= lo, "window starts before the new samples");
                assert!(start + WINDOW as u64 <= written, "window runs past the cursor");
                spans.push((start, start + WINDOW as u64));
            }
            written += step;
        }
        spans
    }

    #[test]
    fn at_most_one_window_per_emit_at_every_rate() {
        for rate in [44_100u32, 96_000, 192_000] {
            let step = u64::from(rate) / 30;
            let spans = run(rate, step, 11);
            assert!(!spans.is_empty());
            assert!(spans.len() as u64 <= u64::from(rate) * 30 / step);
        }
    }

    #[test]
    fn thirty_seconds_of_windows_never_stitch_past_one_window() {
        for rate in [44_100u32, 96_000, 192_000] {
            let step = u64::from(rate) / 30;
            let mut spans = run(rate, step, 12);
            spans.sort();
            let mut longest = 0;
            let (mut run_start, mut run_end) = spans[0];
            for &(s, e) in &spans[1..] {
                if s <= run_end {
                    run_end = run_end.max(e);
                } else {
                    longest = longest.max(run_end - run_start);
                    run_start = s;
                    run_end = e;
                }
            }
            longest = longest.max(run_end - run_start);
            assert!(longest <= WINDOW as u64, "stitched {longest} samples at {rate} Hz");
        }
    }

    #[test]
    fn a_restarted_tap_gives_windows_again() {
        let mut w = on(13);
        assert!(w.window(5000, ring_reader(5000)).is_some());
        assert!(w.window(1000, ring_reader(1000)).is_some());
    }
}
