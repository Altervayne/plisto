/*
 * The EQ's filters: RBJ cookbook biquads in transposed direct form II, and the fixed bank of one filter
 * per band for every channel of a source. Coefficients and state run in f64 so a 60 Hz shelf at a high
 * sample rate keeps its precision. The bank is a fixed array, never allocated, so it lives on the audio
 * thread; a stream with more channels than it holds passes through unfiltered.
 */

// -- Library Imports --
use std::f64::consts::PI;

// -- Local Imports --
use crate::sound_settings::{Band, BandKind, BANDS, BAND_COUNT, PEAK_Q, SHELF_SLOPE};

/// The most interleaved channels the bank filters.
pub const MAX_CHANNELS: usize = 8;

// A band at or above this fraction of the sample rate is left flat: its center sits at or past Nyquist.
const MAX_FREQ_RATIO: f64 = 0.49;

/// One second-order section, normalized so a0 is 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    pub const IDENTITY: Biquad = Biquad {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    /// The filter for one EQ band at `gain_db` on a stream at `rate` Hz. A 0 dB gain, or a band the
    /// rate cannot carry, is the exact identity.
    pub fn for_band(band: Band, gain_db: f64, rate: f64) -> Biquad {
        if gain_db == 0.0 || band.freq_hz >= MAX_FREQ_RATIO * rate {
            return Biquad::IDENTITY;
        }
        match band.kind {
            BandKind::LowShelf => Biquad::low_shelf(band.freq_hz, SHELF_SLOPE, gain_db, rate),
            BandKind::Peak => Biquad::peaking(band.freq_hz, PEAK_Q, gain_db, rate),
            BandKind::HighShelf => Biquad::high_shelf(band.freq_hz, SHELF_SLOPE, gain_db, rate),
        }
    }

    pub fn peaking(freq: f64, q: f64, gain_db: f64, rate: f64) -> Biquad {
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / rate;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        Biquad::normalized(
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos,
            1.0 - alpha / a,
        )
    }

    pub fn low_shelf(freq: f64, slope: f64, gain_db: f64, rate: f64) -> Biquad {
        let (a, cos, beta) = shelf_terms(freq, slope, gain_db, rate);
        Biquad::normalized(
            a * ((a + 1.0) - (a - 1.0) * cos + beta),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
            a * ((a + 1.0) - (a - 1.0) * cos - beta),
            (a + 1.0) + (a - 1.0) * cos + beta,
            -2.0 * ((a - 1.0) + (a + 1.0) * cos),
            (a + 1.0) + (a - 1.0) * cos - beta,
        )
    }

    pub fn high_shelf(freq: f64, slope: f64, gain_db: f64, rate: f64) -> Biquad {
        let (a, cos, beta) = shelf_terms(freq, slope, gain_db, rate);
        Biquad::normalized(
            a * ((a + 1.0) + (a - 1.0) * cos + beta),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
            a * ((a + 1.0) + (a - 1.0) * cos - beta),
            (a + 1.0) - (a - 1.0) * cos + beta,
            2.0 * ((a - 1.0) - (a + 1.0) * cos),
            (a + 1.0) - (a - 1.0) * cos - beta,
        )
    }

    fn normalized(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Biquad {
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }

    /// The filter's gain in dB at `freq` Hz on a stream at `rate` Hz.
    pub fn magnitude_db(&self, freq: f64, rate: f64) -> f64 {
        let w = 2.0 * PI * freq / rate;
        // H(z) at z = e^jw, with z^-1 = cos w - j sin w and z^-2 = cos 2w - j sin 2w.
        let (s1, c1) = w.sin_cos();
        let (s2, c2) = (2.0 * w).sin_cos();
        let num_re = self.b0 + self.b1 * c1 + self.b2 * c2;
        let num_im = -(self.b1 * s1 + self.b2 * s2);
        let den_re = 1.0 + self.a1 * c1 + self.a2 * c2;
        let den_im = -(self.a1 * s1 + self.a2 * s2);
        let num = num_re * num_re + num_im * num_im;
        let den = den_re * den_re + den_im * den_im;
        10.0 * (num / den).log10()
    }

    /// Runs one sample through the filter, updating its two-slot state.
    #[inline]
    pub fn run(&self, x: f64, z: &mut [f64; 2]) -> f64 {
        let y = self.b0 * x + z[0];
        z[0] = self.b1 * x - self.a1 * y + z[1];
        z[1] = self.b2 * x - self.a2 * y;
        y
    }
}

/// The shelf amplitude, cos w0, and the 2 sqrt(A) alpha term shared by both shelves.
fn shelf_terms(freq: f64, slope: f64, gain_db: f64, rate: f64) -> (f64, f64, f64) {
    let a = 10f64.powf(gain_db / 40.0);
    let w0 = 2.0 * PI * freq / rate;
    let (sin, cos) = w0.sin_cos();
    let alpha = sin / 2.0 * ((a + 1.0 / a) * (1.0 / slope - 1.0) + 2.0).sqrt();
    (a, cos, 2.0 * a.sqrt() * alpha)
}

/// The eight band filters in series, with their own state per channel.
pub struct Bank {
    filters: [Biquad; BAND_COUNT],
    state: [[[f64; 2]; BAND_COUNT]; MAX_CHANNELS],
}

impl Bank {
    pub fn new() -> Self {
        Self {
            filters: [Biquad::IDENTITY; BAND_COUNT],
            state: [[[0.0; 2]; BAND_COUNT]; MAX_CHANNELS],
        }
    }

    /// Recomputes every band's filter for `gains_db` at `rate` Hz. Filter state carries over, so a
    /// gliding curve stays continuous.
    pub fn set(&mut self, gains_db: &[f32; BAND_COUNT], rate: u32) {
        for ((filter, band), gain) in self.filters.iter_mut().zip(BANDS).zip(gains_db) {
            *filter = Biquad::for_band(band, *gain as f64, rate as f64);
        }
    }

    /// Clears every channel's filter memory.
    pub fn reset(&mut self) {
        self.state = [[[0.0; 2]; BAND_COUNT]; MAX_CHANNELS];
    }

    /// Filters one sample of `channel`. A channel past MAX_CHANNELS passes through.
    #[inline]
    pub fn process(&mut self, x: f64, channel: usize) -> f64 {
        let Some(state) = self.state.get_mut(channel) else {
            return x;
        };
        let mut y = x;
        for (filter, z) in self.filters.iter().zip(state.iter_mut()) {
            y = filter.run(y, z);
        }
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATES: [f64; 2] = [44_100.0, 96_000.0];

    #[test]
    fn a_6_db_peak_measures_6_db_at_its_center() {
        for rate in RATES {
            let f = Biquad::peaking(1000.0, PEAK_Q, 6.0, rate);
            let db = f.magnitude_db(1000.0, rate);
            assert!((db - 6.0).abs() <= 0.05, "{rate} Hz: {db} dB");
        }
    }

    #[test]
    fn a_peak_leaves_distant_frequencies_flat() {
        for rate in RATES {
            let f = Biquad::peaking(1000.0, PEAK_Q, 6.0, rate);
            assert!(f.magnitude_db(20.0, rate).abs() < 0.05);
            assert!(f.magnitude_db(0.45 * rate, rate).abs() < 0.2);
        }
    }

    #[test]
    fn shelves_reach_their_gain_at_dc_and_nyquist() {
        for rate in RATES {
            let nyquist = rate / 2.0;
            let low = Biquad::low_shelf(60.0, SHELF_SLOPE, 6.0, rate);
            assert!((low.magnitude_db(0.0, rate) - 6.0).abs() < 1e-6);
            assert!(low.magnitude_db(nyquist, rate).abs() < 1e-6);
            let high = Biquad::high_shelf(14_000.0, SHELF_SLOPE, -9.0, rate);
            assert!(high.magnitude_db(0.0, rate).abs() < 1e-6);
            assert!((high.magnitude_db(nyquist, rate) + 9.0).abs() < 1e-6);
        }
    }

    #[test]
    fn zero_gain_and_out_of_range_bands_are_identity() {
        let peak = BANDS[3];
        assert_eq!(Biquad::for_band(peak, 0.0, 44_100.0), Biquad::IDENTITY);
        // 14 kHz cannot be carried at 22.05 kHz.
        assert_eq!(Biquad::for_band(BANDS[7], 6.0, 22_050.0), Biquad::IDENTITY);
        assert_eq!(Biquad::for_band(peak, 6.0, 0.0), Biquad::IDENTITY);
    }

    #[test]
    fn the_bank_filters_a_sine_by_its_band_gain() {
        let rate = 48_000u32;
        let mut gains = [0.0f32; BAND_COUNT];
        gains[3] = 6.0;
        let mut bank = Bank::new();
        bank.set(&gains, rate);
        // One second at 1 kHz; the last half, once the filter has settled, carries the steady gain.
        let n = rate as usize;
        let mut peak = 0.0f64;
        for i in 0..n {
            let x = (2.0 * PI * 1000.0 * i as f64 / rate as f64).sin() * 0.25;
            let y = bank.process(x, 1);
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        let db = 20.0 * (peak / 0.25).log10();
        assert!((db - 6.0).abs() < 0.05, "{db} dB");
    }

    #[test]
    fn a_channel_past_the_bank_passes_through() {
        let mut gains = [0.0f32; BAND_COUNT];
        gains[0] = 12.0;
        let mut bank = Bank::new();
        bank.set(&gains, 44_100);
        assert_eq!(bank.process(0.5, MAX_CHANNELS), 0.5);
    }
}
