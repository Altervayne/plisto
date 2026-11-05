/*
 * Spectrum analysis: one window of mono PCM down to log-spaced band levels for the player's
 * visualizer, plus the window's level and the band-to-band flux. Pure and framework-free - no
 * symphonia, no clock, no state - so it tests on synthetic buffers. The FFT is an in-house radix-2
 * Cooley-Tukey, so the crate needs no DSP dependency. The output is already normalized to 0..1, so
 * the frontend never guesses a scale.
 */

// -- Library Imports --
use std::f32::consts::PI;

// The band range spans the musical spectrum: 40 Hz up to 16 kHz, split log-spaced so each octave gets
// a fair share of bands the way the ear hears pitch.
const F_LO: f32 = 40.0;
const F_HI: f32 = 16_000.0;

// The dB window the bin magnitudes map onto. At or below the floor reads as silence, at the ceiling as
// full. The magnitudes are normalized by the window length first, so a full-scale tone sits near 0 dB.
const DB_FLOOR: f32 = -60.0;
const DB_CEIL: f32 = -10.0;

// Floors the magnitude before log10 so a silent bin yields a finite, very negative dB rather than
// negative infinity.
const EPS: f32 = 1e-9;

/// Log-band levels in 0..1 for one mono window. Pure and deterministic: no clock, no state. A window
/// under two samples, a zero sample rate, or a zero band count yields flat zeros. Uses the largest
/// power-of-two prefix of `samples`, which in practice is the whole window.
pub fn spectrum(samples: &[f32], sample_rate: u32, bands: usize) -> Vec<f32> {
    Bins::of(samples, sample_rate).bands(bands)
}

/// The bin magnitudes of one analyzed window, so several band resolutions read one FFT.
pub struct Bins {
    // Magnitudes of the lower half of the transform; empty for a degenerate window.
    mag: Vec<f32>,
    n: usize,
    sample_rate: u32,
}

impl Bins {
    /// Transforms one mono window. A window under two samples or a zero sample rate gives no bins,
    /// which read as flat zeros.
    pub fn of(samples: &[f32], sample_rate: u32) -> Bins {
        let n = largest_pow2(samples.len());
        if n < 2 || sample_rate == 0 {
            return Bins {
                mag: Vec::new(),
                n,
                sample_rate,
            };
        }

        // Hann-window the input so a tone that does not land on a bin center does not smear across
        // the whole spectrum. Real signal into the real lane, the imaginary lane zeroed.
        let mut re = vec![0.0f32; n];
        let mut im = vec![0.0f32; n];
        for (i, slot) in re.iter_mut().enumerate() {
            let w = 0.5 * (1.0 - (2.0 * PI * i as f32 / (n - 1) as f32).cos());
            *slot = samples[i] * w;
        }

        fft(&mut re, &mut im);

        // Bin magnitudes of the lower half; the upper half mirrors these for a real signal.
        // Normalized by the window length so the dB window above measures against roughly full-scale.
        let half = n / 2;
        let mut mag = vec![0.0f32; half];
        for (k, slot) in mag.iter_mut().enumerate() {
            *slot = (re[k] * re[k] + im[k] * im[k]).sqrt() / n as f32;
        }
        Bins {
            mag,
            n,
            sample_rate,
        }
    }

    /// The window as `bands` log-spaced levels in 0..1 over F_LO..F_HI.
    pub fn bands(&self, bands: usize) -> Vec<f32> {
        if self.mag.is_empty() {
            return vec![0.0; bands];
        }
        let (n, rate, half) = (self.n as f32, self.sample_rate as f32, self.mag.len());
        let mut out = Vec::with_capacity(bands);
        for b in 0..bands {
            let f_lo = band_edge(b, bands);
            let f_hi = band_edge(b + 1, bands);
            // Map the band's frequency edges onto bin indices, clamped into the half spectrum with a
            // non-empty range even when both edges land on the same bin.
            let mut bin_lo = (f_lo * n / rate).floor() as usize;
            let mut bin_hi = (f_hi * n / rate).ceil() as usize;
            bin_lo = bin_lo.min(half - 1);
            bin_hi = bin_hi.clamp(bin_lo + 1, half);
            // The loudest bin in the range drives the band, so a narrow tone still lights its band
            // fully.
            let peak = self.mag[bin_lo..bin_hi]
                .iter()
                .copied()
                .fold(0.0f32, f32::max);
            out.push(to_unit(peak));
        }
        out
    }
}

/// The RMS and peak of one mono window, each in 0..1 through the same dB window as the bands.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Level {
    pub rms: f32,
    pub peak: f32,
}

/// The level of one mono window. An empty window reads as silence.
pub fn level(samples: &[f32]) -> Level {
    if samples.is_empty() {
        return Level {
            rms: 0.0,
            peak: 0.0,
        };
    }
    let mut sum_sq = 0.0f32;
    let mut peak = 0.0f32;
    for &s in samples {
        sum_sq += s * s;
        peak = peak.max(s.abs());
    }
    let rms = (sum_sq / samples.len() as f32).sqrt();
    Level {
        rms: to_unit(rms),
        peak: to_unit(peak),
    }
}

/// Positive spectral flux between two band frames: the mean rise per band, in 0..1. Falling bands
/// count nothing, so a steady or decaying spectrum reads 0 and an onset reads high. Frames of
/// different lengths compare over the shorter one; an empty frame reads 0.
pub fn flux(prev: &[f32], cur: &[f32]) -> f32 {
    let n = prev.len().min(cur.len());
    if n == 0 {
        return 0.0;
    }
    let rise: f32 = prev.iter().zip(cur).map(|(p, c)| (c - p).max(0.0)).sum();
    (rise / n as f32).clamp(0.0, 1.0)
}

/// Maps a linear amplitude onto 0..1 through the DB_FLOOR..DB_CEIL window.
fn to_unit(amplitude: f32) -> f32 {
    let db = 20.0 * (amplitude + EPS).log10();
    ((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)).clamp(0.0, 1.0)
}

/// The lower frequency edge of band `k` of `bands`, log-spaced between F_LO and F_HI.
fn band_edge(k: usize, bands: usize) -> f32 {
    F_LO * (F_HI / F_LO).powf(k as f32 / bands as f32)
}

/// The largest power of two not exceeding `n`, or 0 for `n == 0`.
fn largest_pow2(n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    1usize << (usize::BITS - 1 - n.leading_zeros())
}

/// In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` hold the complex signal and come back as its
/// transform. The length must be a power of two.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    if n < 2 {
        return;
    }
    // Bit-reversal permutation: reorder the samples so the butterfly stages read them in place.
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    // Butterfly stages: the transform length doubles from 2 up to n, combining pairs each stage.
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * PI / len as f32;
        let (wlen_re, wlen_im) = (ang.cos(), ang.sin());
        let mut i = 0;
        while i < n {
            let (mut w_re, mut w_im) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let a = i + k;
                let b = a + len / 2;
                let t_re = re[b] * w_re - im[b] * w_im;
                let t_im = re[b] * w_im + im[b] * w_re;
                re[b] = re[a] - t_re;
                im[b] = im[a] - t_im;
                re[a] += t_re;
                im[a] += t_im;
                let nw_re = w_re * wlen_re - w_im * wlen_im;
                w_im = w_re * wlen_im + w_im * wlen_re;
                w_re = nw_re;
            }
            i += len;
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 44_100;
    const N: usize = 1024;
    const BANDS: usize = 24;
    const FINE: usize = 128;

    // A mono sine of `n` samples at `freq` Hz and `rate`.
    fn sine(n: usize, freq: f32, rate: u32) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * PI * freq * i as f32 / rate as f32).sin())
            .collect()
    }

    // The band whose [f_lo, f_hi) range contains `freq`.
    fn band_of(freq: f32, bands: usize) -> usize {
        (0..bands)
            .find(|&b| band_edge(b, bands) <= freq && freq < band_edge(b + 1, bands))
            .expect("frequency lands inside a band")
    }

    // The index of the loudest band.
    fn argmax(levels: &[f32]) -> usize {
        (0..levels.len())
            .max_by(|&a, &b| levels[a].partial_cmp(&levels[b]).unwrap())
            .unwrap()
    }

    #[test]
    fn a_tone_peaks_in_its_own_band() {
        let levels = spectrum(&sine(N, 440.0, RATE), RATE, BANDS);
        assert_eq!(levels.len(), BANDS);
        let target = band_of(440.0, BANDS);
        assert_eq!(argmax(&levels), target, "440 Hz lights its own band loudest");
        // A distant high band sits well below the tone's band.
        let high = band_of(8000.0, BANDS);
        assert!(
            levels[target] > levels[high] + 0.3,
            "the tone's band towers over a distant one: {} vs {}",
            levels[target],
            levels[high]
        );
    }

    #[test]
    fn a_higher_tone_lights_a_higher_band() {
        let low = spectrum(&sine(N, 440.0, RATE), RATE, BANDS);
        let high = spectrum(&sine(N, 2000.0, RATE), RATE, BANDS);
        assert!(
            argmax(&high) > argmax(&low),
            "2 kHz peaks above 440 Hz's band: {} vs {}",
            argmax(&high),
            argmax(&low)
        );
    }

    #[test]
    fn silence_is_flat_zero() {
        let levels = spectrum(&[0.0; N], RATE, BANDS);
        assert_eq!(levels.len(), BANDS);
        for level in levels {
            assert!(level < 1e-3, "a silent window reads near zero, got {level}");
        }
    }

    #[test]
    fn a_short_window_is_flat_zero() {
        assert_eq!(spectrum(&[0.5], RATE, BANDS), vec![0.0; BANDS]);
    }

    #[test]
    fn fine_bands_come_from_the_same_window() {
        let bins = Bins::of(&sine(N, 440.0, RATE), RATE);
        assert_eq!(
            bins.bands(BANDS),
            spectrum(&sine(N, 440.0, RATE), RATE, BANDS)
        );
        assert_eq!(bins.bands(FINE).len(), FINE);
    }

    #[test]
    fn fine_bands_are_zero_for_silence() {
        assert_eq!(Bins::of(&[0.0; N], RATE).bands(FINE), vec![0.0; FINE]);
    }

    #[test]
    fn a_tone_peaks_in_its_own_fine_band() {
        for freq in [440.0, 1000.0, 5000.0] {
            let levels = Bins::of(&sine(N, freq, RATE), RATE).bands(FINE);
            let target = band_of(freq, FINE);
            // Fine bands are narrower than a bin low down, so a neighbor may tie the tone's band.
            let loudest = levels.iter().copied().fold(0.0f32, f32::max);
            assert_eq!(
                levels[target], loudest,
                "{freq} Hz lights its own band loudest"
            );
            assert!(argmax(&levels).abs_diff(target) <= 2, "{freq} Hz");
            let far = band_of(if freq < 2000.0 { 9000.0 } else { 100.0 }, FINE);
            assert!(
                levels[target] > levels[far] + 0.3,
                "{freq} Hz towers over a distant band"
            );
        }
    }

    #[test]
    fn zero_bands_is_empty() {
        assert!(spectrum(&sine(N, 440.0, RATE), RATE, 0).is_empty());
    }

    // ---- Level and flux ----

    // A sine at a quarter of the rate samples 0, a, 0, -a: its peak is exactly `amp` and its RMS
    // exactly amp / sqrt(2), so the expected levels follow from the dB window alone.
    fn quarter_rate_sine(n: usize, amp: f32) -> Vec<f32> {
        sine(n, RATE as f32 / 4.0, RATE)
            .into_iter()
            .map(|s| s * amp)
            .collect()
    }

    fn unit_of_db(db: f32) -> f32 {
        ((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)).clamp(0.0, 1.0)
    }

    #[test]
    fn silence_has_zero_level() {
        assert_eq!(
            level(&[0.0; N]),
            Level {
                rms: 0.0,
                peak: 0.0
            }
        );
        assert_eq!(level(&[]).rms, 0.0);
    }

    #[test]
    fn a_full_scale_sine_fills_the_window() {
        // 0 dBFS peak and -3 dBFS RMS both sit above the -10 dB ceiling.
        let l = level(&quarter_rate_sine(N, 1.0));
        assert!((l.peak - 1.0).abs() < 1e-6, "peak {}", l.peak);
        assert!((l.rms - 1.0).abs() < 1e-6, "rms {}", l.rms);
    }

    #[test]
    fn a_minus_30_dbfs_sine_reads_its_place_in_the_window() {
        let amp = 10f32.powf(-30.0 / 20.0);
        let l = level(&quarter_rate_sine(N, amp));
        let rms_db = -30.0 - 20.0 * 2f32.sqrt().log10();
        assert!((l.peak - unit_of_db(-30.0)).abs() < 1e-3, "peak {}", l.peak);
        assert!((l.rms - unit_of_db(rms_db)).abs() < 1e-3, "rms {}", l.rms);
    }

    #[test]
    fn a_steady_frame_pair_has_no_flux() {
        let frame = spectrum(&sine(N, 440.0, RATE), RATE, BANDS);
        assert_eq!(flux(&frame, &frame), 0.0);
    }

    #[test]
    fn a_step_up_has_positive_flux_and_a_step_down_none() {
        let quiet = [0.0f32; BANDS];
        let loud = spectrum(&sine(N, 440.0, RATE), RATE, BANDS);
        assert!(flux(&quiet, &loud) > 0.0);
        assert_eq!(flux(&loud, &quiet), 0.0);
        assert_eq!(flux(&quiet, &[1.0; BANDS]), 1.0);
    }

    #[test]
    fn an_empty_frame_has_no_flux() {
        assert_eq!(flux(&[], &[0.5; BANDS]), 0.0);
    }
}
