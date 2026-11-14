/*
 * Peak and RMS per channel over a window of tap samples, and the text built from them. A window
 * is what arrived since the last `take`; a discontinuity (new epoch, overrun) discards it, since levels
 * across a seek mean nothing.
 */

// -- Local Imports --
use crate::tap::Segment;

// The widest layout the tap's writer allows for.
const MAX_CHANNELS: usize = 32;

#[derive(Default)]
pub struct Levels {
    peak: Vec<f32>,
    sum_sq: Vec<f64>,
    frames: Vec<u64>,
}

/// Levels in dBFS for each channel, None for a channel that got no samples.
#[derive(Debug, PartialEq)]
pub struct Window {
    pub peak_db: Vec<Option<f32>>,
    pub rms_db: Vec<Option<f32>>,
}

fn db(linear: f64) -> f32 {
    (20.0 * linear.log10()) as f32
}

impl Levels {
    /// Adds a chunk of interleaved samples of `segment`, `first` being the cursor of `data[0]`.
    pub fn add(&mut self, segment: &Segment, first: u64, data: &[f32]) {
        let channels = (segment.channels as usize).min(MAX_CHANNELS);
        if channels == 0 {
            return;
        }
        if self.peak.len() != channels {
            self.peak = vec![0.0; channels];
            self.sum_sq = vec![0.0; channels];
            self.frames = vec![0; channels];
        }
        let mut channel = ((first - segment.start_cursor) % segment.channels as u64) as usize;
        for &s in data {
            if channel < channels {
                self.peak[channel] = self.peak[channel].max(s.abs());
                self.sum_sq[channel] += f64::from(s) * f64::from(s);
                self.frames[channel] += 1;
            }
            channel = (channel + 1) % segment.channels as usize;
        }
    }

    /// Drops everything accumulated.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The levels since the last call, which starts a new window.
    pub fn take(&mut self) -> Window {
        let level = |linear: f64, n: u64| (n > 0).then(|| db(linear));
        let window = Window {
            peak_db: (0..self.peak.len())
                .map(|c| level(f64::from(self.peak[c]), self.frames[c]))
                .collect(),
            rms_db: (0..self.peak.len())
                .map(|c| {
                    level(
                        (self.sum_sq[c] / self.frames[c].max(1) as f64).sqrt(),
                        self.frames[c],
                    )
                })
                .collect(),
        };
        for c in 0..self.peak.len() {
            self.peak[c] = 0.0;
            self.sum_sq[c] = 0.0;
            self.frames[c] = 0;
        }
        window
    }
}

fn list(values: &[Option<f32>]) -> String {
    let cells: Vec<String> = values
        .iter()
        .map(|v| match v {
            Some(d) if *d > -120.0 => format!("{d:.1}"),
            _ => "-inf".to_string(),
        })
        .collect();
    cells.join(" ")
}

/// The peak of each channel in dB, such as `peak -6.0 -inf dB`; None when no channel got samples.
pub fn peak_text(window: &Window) -> Option<String> {
    if window.peak_db.iter().all(Option::is_none) {
        return None;
    }
    Some(format!("peak {} dB", list(&window.peak_db)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEREO: Segment = Segment {
        start_cursor: 100,
        epoch: 1,
        rate: 44_100,
        channels: 2,
    };

    #[test]
    fn peak_and_rms_are_per_channel() {
        let mut levels = Levels::default();
        // Left holds 0.5, right alternates 1.0 and -1.0.
        levels.add(&STEREO, 100, &[0.5, 1.0, 0.5, -1.0]);
        let w = levels.take();
        assert!((w.peak_db[0].unwrap() + 6.02).abs() < 0.01);
        assert!((w.rms_db[0].unwrap() + 6.02).abs() < 0.01);
        assert!(w.peak_db[1].unwrap().abs() < 0.01);
        assert!(w.rms_db[1].unwrap().abs() < 0.01);
    }

    #[test]
    fn a_chunk_that_starts_mid_frame_keeps_its_channels() {
        let mut levels = Levels::default();
        // Cursor 101 is the right channel of the first frame.
        levels.add(&STEREO, 101, &[1.0, 0.25]);
        let w = levels.take();
        assert!((w.peak_db[0].unwrap() + 12.04).abs() < 0.01);
        assert!(w.peak_db[1].unwrap().abs() < 0.01);
    }

    #[test]
    fn a_window_starts_empty_after_take() {
        let mut levels = Levels::default();
        levels.add(&STEREO, 100, &[0.5, 0.5]);
        levels.take();
        let w = levels.take();
        assert_eq!(w.peak_db, vec![None, None]);
        assert_eq!(peak_text(&w), None);
    }

    #[test]
    fn the_peak_text_lists_every_channel() {
        let mut levels = Levels::default();
        levels.add(&STEREO, 100, &[0.5, 0.0]);
        assert_eq!(
            peak_text(&levels.take()).as_deref(),
            Some("peak -6.0 -inf dB")
        );
    }
}
