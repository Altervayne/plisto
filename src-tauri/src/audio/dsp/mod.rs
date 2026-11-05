/*
 * The per-source DSP stage and the live parameter block it reads. The engine thread writes the block;
 * each source's stage re-reads it once per decoded packet through a seqlock, so the audio thread never
 * locks or allocates. With the EQ off, levelling off and no preamp, the stage is bypassed and its
 * output is the decoded sample, bit for bit.
 */

// -- Library Imports --
use std::sync::atomic::{fence, AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

// -- Local Imports --
use crate::sound_settings::{Levelling, BAND_COUNT};

/// One consistent set of live DSP parameters, as the stage reads them from `DspShared`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DspParams {
    pub eq_on: bool,
    pub gains_db: [f32; BAND_COUNT],
    pub preamp_db: f32,
    pub levelling: Levelling,
}

impl Default for DspParams {
    fn default() -> Self {
        Self {
            eq_on: false,
            gains_db: [0.0; BAND_COUNT],
            preamp_db: 0.0,
            levelling: Levelling::Off,
        }
    }
}

impl DspParams {
    /// Whether these parameters leave every sample untouched, so the stage can bypass itself.
    pub fn is_identity(&self) -> bool {
        !self.eq_on && self.preamp_db == 0.0 && self.levelling == Levelling::Off
    }
}

/// The live parameter block shared by the engine and every source. One writer (the engine thread),
/// many readers (the sources on rodio's mixer thread). Floats ride as their bits in AtomicU32. The
/// default is the identity set.
#[derive(Default)]
pub struct DspShared {
    // Odd while a write is in flight; each completed write moves it on by two.
    seq: AtomicU32,
    eq_on: AtomicBool,
    gains_db: [AtomicU32; BAND_COUNT],
    preamp_db: AtomicU32,
    // 0 is off, 1 is track.
    levelling: AtomicU32,
}

impl DspShared {
    /// Publishes `p` as one consistent set. Single writer: only the engine thread calls this.
    pub fn store(&self, p: &DspParams) {
        let s = self.seq.load(Ordering::Relaxed);
        self.seq.store(s.wrapping_add(1), Ordering::Relaxed);
        // Keeps the odd marker ahead of the field writes for any reader that sees a field.
        fence(Ordering::Release);
        self.eq_on.store(p.eq_on, Ordering::Relaxed);
        for (slot, g) in self.gains_db.iter().zip(p.gains_db) {
            slot.store(g.to_bits(), Ordering::Relaxed);
        }
        self.preamp_db
            .store(p.preamp_db.to_bits(), Ordering::Relaxed);
        let mode = match p.levelling {
            Levelling::Off => 0,
            Levelling::Track => 1,
        };
        self.levelling.store(mode, Ordering::Relaxed);
        self.seq.store(s.wrapping_add(2), Ordering::Release);
    }

    /// Reads one consistent set, retrying while a write is in flight or landed mid-read. No lock and
    /// no allocation, so it is safe on the audio thread.
    pub fn load(&self) -> DspParams {
        loop {
            let before = self.seq.load(Ordering::Acquire);
            if before & 1 == 0 {
                let mut gains_db = [0.0f32; BAND_COUNT];
                for (g, slot) in gains_db.iter_mut().zip(&self.gains_db) {
                    *g = f32::from_bits(slot.load(Ordering::Relaxed));
                }
                let p = DspParams {
                    eq_on: self.eq_on.load(Ordering::Relaxed),
                    gains_db,
                    preamp_db: f32::from_bits(self.preamp_db.load(Ordering::Relaxed)),
                    levelling: match self.levelling.load(Ordering::Relaxed) {
                        1 => Levelling::Track,
                        _ => Levelling::Off,
                    },
                };
                fence(Ordering::Acquire);
                if self.seq.load(Ordering::Relaxed) == before {
                    return p;
                }
            }
            std::hint::spin_loop();
        }
    }
}

/// The processing stage one source runs on every decoded sample, before the spectrum tap. It holds
/// its own snapshot of the live parameters and re-reads them only at a packet refill.
pub struct DspStage {
    shared: Arc<DspShared>,
    params: DspParams,
    bypass: bool,
    // The track's levelling gain in dB, applied only while levelling is on.
    track_gain_db: f32,
    // Linear gain on the processing path.
    gain: f32,
}

impl DspStage {
    /// A stage reading `shared`, starting at its current parameters so it applies from sample 0.
    pub fn new(shared: Arc<DspShared>, track_gain_db: f32) -> Self {
        let params = shared.load();
        Self {
            shared,
            params,
            bypass: params.is_identity(),
            track_gain_db,
            gain: 1.0,
        }
    }

    /// Re-reads the live parameters. Called once per packet refill, never per sample.
    pub fn refresh(&mut self) {
        self.params = self.shared.load();
        self.bypass = self.params.is_identity();
    }

    /// Processes one interleaved sample of `channel`. Bypassed, it returns `s` unchanged.
    #[inline]
    pub fn process(&mut self, s: f32, _channel: u16) -> f32 {
        if self.bypass {
            s
        } else {
            s * self.gain
        }
    }

    /// A non-identity stage with a fixed linear gain, to observe where the stage sits in a source.
    #[cfg(test)]
    pub(crate) fn with_gain(gain: f32) -> Self {
        let shared = Arc::new(DspShared::default());
        shared.store(&DspParams {
            eq_on: true,
            ..DspParams::default()
        });
        let mut stage = Self::new(shared, 0.0);
        stage.gain = gain;
        stage
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_block_is_identity() {
        let shared = Arc::new(DspShared::default());
        assert_eq!(shared.load(), DspParams::default());
        assert!(shared.load().is_identity());
    }

    #[test]
    fn a_stored_set_reads_back_whole() {
        let shared = DspShared::default();
        let p = DspParams {
            eq_on: true,
            gains_db: [1.0, -2.0, 3.0, -4.0, 5.0, -6.0, 7.0, -8.0],
            preamp_db: -3.5,
            levelling: Levelling::Track,
        };
        shared.store(&p);
        assert_eq!(shared.load(), p);
        assert!(!shared.load().is_identity());
    }

    #[test]
    fn any_active_parameter_breaks_identity() {
        let eq = DspParams {
            eq_on: true,
            ..DspParams::default()
        };
        let preamp = DspParams {
            preamp_db: -1.0,
            ..DspParams::default()
        };
        let levelling = DspParams {
            levelling: Levelling::Track,
            ..DspParams::default()
        };
        assert!(!eq.is_identity());
        assert!(!preamp.is_identity());
        assert!(!levelling.is_identity());
    }

    #[test]
    fn a_bypassed_stage_returns_the_sample_bits() {
        let mut stage = DspStage::new(Arc::new(DspShared::default()), 0.0);
        for s in [0.0f32, -0.0, 1.0, -1.0, 0.123_456_79, f32::MIN_POSITIVE] {
            assert_eq!(stage.process(s, 0).to_bits(), s.to_bits());
        }
    }

    #[test]
    fn refresh_picks_up_a_new_set() {
        let shared = Arc::new(DspShared::default());
        let mut stage = DspStage::new(Arc::clone(&shared), 0.0);
        assert!(stage.bypass);
        shared.store(&DspParams {
            eq_on: true,
            ..DspParams::default()
        });
        assert!(stage.bypass, "the stage holds its snapshot until a refresh");
        stage.refresh();
        assert!(!stage.bypass);
    }
}
