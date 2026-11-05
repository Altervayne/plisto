/*
 * The per-track levelling gain rule. A tag track gain wins; otherwise a measurement that still
 * describes the file; otherwise 0 dB. The result is always computed here, and the DSP stage decides
 * whether it applies from the levelling mode.
 */

/// ReplayGain 2 reference loudness a measured track is levelled to.
const TARGET_LUFS: f64 = -18.0;
/// Opus `R128_*` gains are relative to -23 LUFS; this moves them onto the -18 LUFS reference.
const OPUS_OFFSET_DB: f64 = 5.0;
const MIN_DB: f64 = -24.0;
const MAX_DB: f64 = 12.0;

/// What is known about one track. `measured_*` must already be stamp-checked against the file's
/// current size and mtime; a stale measurement is passed as None.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GainInputs {
    pub tag_gain_db: Option<f64>,
    pub tag_peak: Option<f64>,
    pub measured_lufs: Option<f64>,
    pub measured_peak: Option<f64>,
    /// The stored tag gain came from `R128_*` (an Opus file).
    pub opus: bool,
}

/// The levelling gain in dB for a track, clamped to [-24, +12]. A boost never lifts the known peak
/// above full scale.
pub fn track_gain_db(i: &GainInputs) -> f32 {
    let (gain, peak) = match (i.tag_gain_db, i.measured_lufs) {
        (Some(g), _) => (g + if i.opus { OPUS_OFFSET_DB } else { 0.0 }, i.tag_peak),
        (None, Some(lufs)) => (TARGET_LUFS - lufs, i.measured_peak),
        (None, None) => return 0.0,
    };
    let capped = match peak.filter(|p| *p > 0.0) {
        Some(p) if gain > 0.0 => gain.min(-20.0 * p.log10()),
        _ => gain,
    };
    capped.clamp(MIN_DB, MAX_DB) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tagged(gain: f64) -> GainInputs {
        GainInputs {
            tag_gain_db: Some(gain),
            ..GainInputs::default()
        }
    }

    #[test]
    fn a_tag_gain_wins_over_a_measurement() {
        let i = GainInputs {
            measured_lufs: Some(-30.0),
            ..tagged(-4.0)
        };
        assert_eq!(track_gain_db(&i), -4.0);
    }

    #[test]
    fn a_measurement_levels_to_the_reference() {
        let i = GainInputs {
            measured_lufs: Some(-24.0),
            ..GainInputs::default()
        };
        assert_eq!(track_gain_db(&i), 6.0);
        let loud = GainInputs {
            measured_lufs: Some(-10.0),
            ..GainInputs::default()
        };
        assert_eq!(track_gain_db(&loud), -8.0);
    }

    #[test]
    fn no_data_is_zero_db() {
        assert_eq!(track_gain_db(&GainInputs::default()), 0.0);
    }

    #[test]
    fn opus_tag_gain_moves_to_the_minus_18_reference() {
        let i = GainInputs {
            opus: true,
            ..tagged(-3.0)
        };
        assert_eq!(track_gain_db(&i), 2.0);
    }

    #[test]
    fn a_boost_is_capped_by_the_tag_peak() {
        // Peak 0.5 leaves 6.02 dB of headroom.
        let i = GainInputs {
            tag_peak: Some(0.5),
            ..tagged(10.0)
        };
        let g = track_gain_db(&i);
        assert!((g - 6.0206).abs() < 1e-3, "{g}");
        assert!(0.5 * 10f64.powf(g as f64 / 20.0) <= 1.0 + 1e-6);
    }

    #[test]
    fn a_boost_is_capped_by_the_measured_peak() {
        let i = GainInputs {
            measured_lufs: Some(-28.0),
            measured_peak: Some(0.8),
            ..GainInputs::default()
        };
        let g = track_gain_db(&i);
        assert!((g - 1.9382).abs() < 1e-3, "{g}");
    }

    #[test]
    fn a_cut_is_never_capped_and_an_unknown_peak_does_not_cap() {
        let cut = GainInputs {
            tag_peak: Some(0.1),
            ..tagged(-6.0)
        };
        assert_eq!(track_gain_db(&cut), -6.0);
        assert_eq!(track_gain_db(&tagged(8.0)), 8.0);
    }

    #[test]
    fn the_result_is_clamped() {
        assert_eq!(track_gain_db(&tagged(20.0)), 12.0);
        assert_eq!(track_gain_db(&tagged(-30.0)), -24.0);
        let quiet = GainInputs {
            measured_lufs: Some(-50.0),
            ..GainInputs::default()
        };
        assert_eq!(track_gain_db(&quiet), 12.0);
    }
}
