/*
 * The output safety stage: a stateless soft knee. Below -1 dBFS a sample passes untouched; above it,
 * the excess is folded through tanh into the last decibel, so a boosted peak rounds off instead of
 * clipping and the output never exceeds full scale. The curve's slope is 1 at the knee, so there is no
 * corner to hear.
 */

// -1 dBFS.
const KNEE: f32 = 0.891_250_9;
const SPAN: f32 = 1.0 - KNEE;

/// Limits one sample to [-1.0, 1.0] with a soft knee from -1 dBFS.
#[inline]
pub fn soft_limit(x: f32) -> f32 {
    let mag = x.abs();
    if mag <= KNEE {
        return x;
    }
    let y = (KNEE + SPAN * ((mag - KNEE) / SPAN).tanh()).min(1.0);
    y.copysign(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_the_knee_passes_bit_for_bit() {
        for x in [0.0f32, -0.0, 0.25, -0.5, 0.89, -KNEE, KNEE] {
            assert_eq!(soft_limit(x).to_bits(), x.to_bits());
        }
    }

    #[test]
    fn a_12_db_overdrive_stays_at_or_under_full_scale() {
        // Up to +12 dB over full scale, in fine steps, both polarities.
        let top = 10f32.powf(12.0 / 20.0);
        let mut prev = 0.0f32;
        for i in 0..=40_000 {
            let x = top * i as f32 / 40_000.0;
            let y = soft_limit(x);
            assert!(y <= 1.0, "{x} -> {y}");
            assert!(soft_limit(-x) >= -1.0);
            assert!(y >= prev, "the curve never folds back: {x} -> {y}");
            prev = y;
        }
    }

    #[test]
    fn the_knee_has_no_corner() {
        let step = 1e-4f32;
        let below = soft_limit(KNEE) - soft_limit(KNEE - step);
        let above = soft_limit(KNEE + step) - soft_limit(KNEE);
        assert!((below - above).abs() < 1e-5, "{below} vs {above}");
    }
}
