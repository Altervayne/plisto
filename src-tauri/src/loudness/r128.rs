/*
 * EBU R128 integrated loudness (ITU-R BS.1770) and sample peak, as a pure streaming meter. Samples go
 * through the two-stage K-weighting filter, whose coefficients are derived from the analog prototype
 * for the stream's own rate, so any rate measures the same as the 48 kHz reference table. Mean squares
 * are kept per 100 ms step; a 400 ms gating block is four consecutive steps, which gives the 75%
 * overlap. Only one weighted energy per step is stored, since a block's energy is linear in its steps.
 */

/// The most channels the meter weights. Beyond it, `Meter::new` refuses the stream.
pub const MAX_CHANNELS: usize = 8;

const ABSOLUTE_GATE_LUFS: f64 = -70.0;
const RELATIVE_GATE_LU: f64 = -10.0;
const STEPS_PER_BLOCK: usize = 4;

// The analog prototype of the K-weighting stages (pre-filter shelf, then the RLB high-pass), from
// which the 48 kHz BS.1770 coefficients are recovered exactly.
const SHELF_F0: f64 = 1681.974450955533;
const SHELF_GAIN_DB: f64 = 3.999843853973347;
const SHELF_Q: f64 = 0.7071752369554196;
const HIGH_PASS_F0: f64 = 38.13547087602444;
const HIGH_PASS_Q: f64 = 0.5003270373238773;

/// One biquad in direct form I: `b` feed-forward, `a` feedback with a0 normalized to 1.
#[derive(Clone, Copy, Debug)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn new(b: [f64; 3], a: [f64; 2]) -> Self {
        Biquad {
            b,
            a,
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn run(&mut self, input: f64) -> f64 {
        let out = self.b[0] * input + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [input, self.x[0]];
        self.y = [out, self.y[0]];
        out
    }
}

/// The two K-weighting stages for `rate`, as (shelf, high-pass).
fn k_weighting(rate: f64) -> (Biquad, Biquad) {
    let k = (std::f64::consts::PI * SHELF_F0 / rate).tan();
    let vh = 10f64.powf(SHELF_GAIN_DB / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / SHELF_Q + k * k;
    let shelf = Biquad::new(
        [
            (vh + vb * k / SHELF_Q + k * k) / a0,
            2.0 * (k * k - vh) / a0,
            (vh - vb * k / SHELF_Q + k * k) / a0,
        ],
        [2.0 * (k * k - 1.0) / a0, (1.0 - k / SHELF_Q + k * k) / a0],
    );

    let k = (std::f64::consts::PI * HIGH_PASS_F0 / rate).tan();
    let a0 = 1.0 + k / HIGH_PASS_Q + k * k;
    let high_pass = Biquad::new(
        [1.0, -2.0, 1.0],
        [
            2.0 * (k * k - 1.0) / a0,
            (1.0 - k / HIGH_PASS_Q + k * k) / a0,
        ],
    );
    (shelf, high_pass)
}

/// The BS.1770 weight of each channel in the default WAVE/FLAC order. Front channels count 1.0, the
/// LFE (fourth of five-point-one and up) is left out, and every surround or back channel counts 1.41.
fn channel_weights(channels: usize) -> [f64; MAX_CHANNELS] {
    const S: f64 = 1.41;
    let table: &[f64] = match channels {
        1 => &[1.0],
        2 => &[1.0, 1.0],
        3 => &[1.0, 1.0, 1.0],
        4 => &[1.0, 1.0, S, S],
        5 => &[1.0, 1.0, 1.0, S, S],
        6 => &[1.0, 1.0, 1.0, 0.0, S, S],
        7 => &[1.0, 1.0, 1.0, 0.0, S, S, S],
        _ => &[1.0, 1.0, 1.0, 0.0, S, S, S, S],
    };
    let mut weights = [0.0; MAX_CHANNELS];
    weights[..table.len()].copy_from_slice(table);
    weights
}

/// A streaming loudness meter for one stream of fixed rate and channel count.
pub struct Meter {
    channels: usize,
    weights: [f64; MAX_CHANNELS],
    filters: Vec<(Biquad, Biquad)>,
    step_len: usize,
    step_pos: usize,
    step_sums: [f64; MAX_CHANNELS],
    /// The channel-weighted mean square of each completed 100 ms step.
    steps: Vec<f64>,
    peak: f32,
}

impl Meter {
    /// A meter for `sample_rate` and `channels`, or None for a zero rate or a channel count outside
    /// 1..=8.
    pub fn new(sample_rate: u32, channels: usize) -> Option<Meter> {
        if sample_rate == 0 || channels == 0 || channels > MAX_CHANNELS {
            return None;
        }
        let filters = (0..channels)
            .map(|_| k_weighting(f64::from(sample_rate)))
            .collect();
        Some(Meter {
            channels,
            weights: channel_weights(channels),
            filters,
            step_len: (sample_rate as usize).div_ceil(10),
            step_pos: 0,
            step_sums: [0.0; MAX_CHANNELS],
            steps: Vec::new(),
            peak: 0.0,
        })
    }

    /// Feeds interleaved samples holding whole frames.
    pub fn push(&mut self, interleaved: &[f32]) {
        for frame in interleaved.chunks_exact(self.channels) {
            for (ch, &sample) in frame.iter().enumerate() {
                self.peak = self.peak.max(sample.abs());
                let (shelf, high_pass) = &mut self.filters[ch];
                let weighted = high_pass.run(shelf.run(f64::from(sample)));
                self.step_sums[ch] += weighted * weighted;
            }
            self.step_pos += 1;
            if self.step_pos == self.step_len {
                let energy: f64 = (0..self.channels)
                    .map(|ch| self.weights[ch] * self.step_sums[ch])
                    .sum();
                self.steps.push(energy / self.step_len as f64);
                self.step_sums = [0.0; MAX_CHANNELS];
                self.step_pos = 0;
            }
        }
    }

    /// The gated integrated loudness in LUFS, or None when no block passes the gates: silence, or a
    /// stream shorter than one 400 ms block.
    pub fn integrated(&self) -> Option<f64> {
        let blocks: Vec<f64> = self
            .steps
            .windows(STEPS_PER_BLOCK)
            .map(|w| w.iter().sum::<f64>() / STEPS_PER_BLOCK as f64)
            .collect();
        let absolute = energy_of(ABSOLUTE_GATE_LUFS);
        let above: Vec<f64> = blocks.into_iter().filter(|&z| z > absolute).collect();
        if above.is_empty() {
            return None;
        }
        let relative = mean(&above) * 10f64.powf(RELATIVE_GATE_LU / 10.0);
        let gated: Vec<f64> = above.into_iter().filter(|&z| z > relative).collect();
        if gated.is_empty() {
            return None;
        }
        Some(loudness_of(mean(&gated)))
    }

    /// The largest absolute sample seen, as linear amplitude.
    pub fn peak(&self) -> f64 {
        f64::from(self.peak)
    }
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn loudness_of(energy: f64) -> f64 {
    -0.691 + 10.0 * energy.log10()
}

/// The weighted energy whose loudness is `lufs`.
fn energy_of(lufs: f64) -> f64 {
    10f64.powf((lufs + 0.691) / 10.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `secs` of a 1 kHz sine at `dbfs` peak amplitude on every one of `channels`, then `silence_secs`
    // of digital silence, interleaved.
    fn sine(rate: u32, channels: usize, dbfs: f64, secs: f64, silence_secs: f64) -> Vec<f32> {
        let amp = 10f64.powf(dbfs / 20.0);
        let tone = (f64::from(rate) * secs) as usize;
        let quiet = (f64::from(rate) * silence_secs) as usize;
        let mut out = Vec::with_capacity((tone + quiet) * channels);
        for n in 0..tone {
            let t = n as f64 / f64::from(rate);
            let s = (amp * (2.0 * std::f64::consts::PI * 1000.0 * t).sin()) as f32;
            out.extend(std::iter::repeat_n(s, channels));
        }
        out.extend(std::iter::repeat_n(0.0, quiet * channels));
        out
    }

    fn measure(rate: u32, channels: usize, samples: &[f32]) -> Option<f64> {
        let mut meter = Meter::new(rate, channels).unwrap();
        // Fed in chunks that straddle the 100 ms steps, the way packets arrive.
        for chunk in samples.chunks(1234 * channels) {
            meter.push(chunk);
        }
        meter.integrated()
    }

    #[test]
    fn k_weighting_at_48k_matches_the_bs1770_table() {
        let (shelf, high_pass) = k_weighting(48_000.0);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
        assert!(close(shelf.b[0], 1.53512485958697));
        assert!(close(shelf.b[1], -2.69169618940638));
        assert!(close(shelf.b[2], 1.19839281085285));
        assert!(close(shelf.a[0], -1.69065929318241));
        assert!(close(shelf.a[1], 0.73248077421585));
        assert!(close(high_pass.a[0], -1.99004745483398));
        assert!(close(high_pass.a[1], 0.99007225036621));
    }

    #[test]
    fn stereo_sine_at_minus_23_dbfs_reads_minus_23_lufs_at_48k() {
        let lufs = measure(48_000, 2, &sine(48_000, 2, -23.0, 20.0, 0.0)).unwrap();
        assert!((lufs + 23.0).abs() <= 0.1, "{lufs}");
    }

    #[test]
    fn stereo_sine_at_minus_33_dbfs_reads_minus_33_lufs_at_48k() {
        let lufs = measure(48_000, 2, &sine(48_000, 2, -33.0, 20.0, 0.0)).unwrap();
        assert!((lufs + 33.0).abs() <= 0.1, "{lufs}");
    }

    #[test]
    fn stereo_sine_at_minus_23_dbfs_reads_minus_23_lufs_at_44k1() {
        let lufs = measure(44_100, 2, &sine(44_100, 2, -23.0, 20.0, 0.0)).unwrap();
        assert!((lufs + 23.0).abs() <= 0.1, "{lufs}");
    }

    #[test]
    fn a_long_silence_is_gated_out() {
        let alone = measure(48_000, 2, &sine(48_000, 2, -23.0, 20.0, 0.0)).unwrap();
        let padded = measure(48_000, 2, &sine(48_000, 2, -23.0, 20.0, 60.0)).unwrap();
        assert!((alone - padded).abs() <= 0.1, "{alone} vs {padded}");

        let alone = measure(44_100, 2, &sine(44_100, 2, -23.0, 20.0, 0.0)).unwrap();
        let padded = measure(44_100, 2, &sine(44_100, 2, -23.0, 20.0, 60.0)).unwrap();
        assert!((alone - padded).abs() <= 0.1, "{alone} vs {padded}");
    }

    #[test]
    fn silence_and_a_sub_block_stream_have_no_loudness() {
        assert_eq!(measure(48_000, 2, &vec![0.0; 48_000 * 2 * 5]), None);
        assert_eq!(measure(48_000, 2, &sine(48_000, 2, -23.0, 0.3, 0.0)), None);
    }

    #[test]
    fn a_surround_channel_weighs_1_41_and_the_lfe_nothing() {
        let rate = 48_000;
        let tone = sine(rate, 1, -23.0, 10.0, 0.0);
        let one_channel = |slot: usize| {
            let mut out = vec![0.0f32; tone.len() * 6];
            for (n, &s) in tone.iter().enumerate() {
                out[n * 6 + slot] = s;
            }
            measure(rate, 6, &out)
        };
        let front = one_channel(0).unwrap();
        let surround = one_channel(4).unwrap();
        assert!((surround - front - 10.0 * 1.41f64.log10()).abs() < 0.01);
        assert_eq!(one_channel(3), None);
    }

    #[test]
    fn peak_is_the_largest_absolute_sample() {
        let mut meter = Meter::new(48_000, 2).unwrap();
        meter.push(&[0.1, -0.7, 0.5, 0.2]);
        assert!((meter.peak() - 0.7).abs() < 1e-6);
    }

    #[test]
    fn an_unsupported_layout_has_no_meter() {
        assert!(Meter::new(0, 2).is_none());
        assert!(Meter::new(48_000, 0).is_none());
        assert!(Meter::new(48_000, 9).is_none());
    }
}
