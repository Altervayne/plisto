/*
 * The per-source DSP stage and the live parameter block it reads. The engine thread writes the block;
 * each source's stage re-reads it once per decoded packet through a seqlock, so the audio thread never
 * locks or allocates. The chain is gain (preamp, auto headroom and levelling), the eight EQ bands, then
 * the soft limiter. With the EQ off or flat, levelling off and no preamp, the stage is bypassed and its
 * output is the decoded sample, bit for bit.
 */

// -- Module Declarations --
mod biquad;
pub mod gain;
mod limiter;

// -- Library Imports --
use std::sync::atomic::{fence, AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

// -- Local Imports --
use super::AudioSpec;
use crate::sound_settings::{Levelling, SoundSettings, BAND_COUNT};
use biquad::{Bank, MAX_CHANNELS};

// The time constant of every parameter glide. A preset change settles in a few of these.
const GLIDE_SECS: f64 = 0.05;
// While gliding, the band filters are recomputed once per this many frames.
const RAMP_FRAMES: u32 = 32;
// A glide snaps to its target once every band is this close in dB and the gain this close in linear.
const SETTLE_DB: f32 = 0.005;
const SETTLE_GAIN: f64 = 1e-5;

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

impl From<&SoundSettings> for DspParams {
    fn from(s: &SoundSettings) -> Self {
        Self {
            eq_on: s.eq.on,
            gains_db: s.eq.gains.map(|g| g as f32),
            preamp_db: s.preamp_db as f32,
            levelling: s.levelling,
        }
    }
}

impl DspParams {
    /// Whether these parameters leave every sample untouched, so the stage can bypass itself. A flat
    /// EQ counts as off, so switching it on does not bring in the limiter.
    pub fn is_identity(&self) -> bool {
        self.band_targets() == [0.0; BAND_COUNT]
            && self.preamp_db == 0.0
            && self.levelling == Levelling::Off
    }

    /// The band gains the filters aim for: the curve while the EQ is on, flat while it is off.
    fn band_targets(&self) -> [f32; BAND_COUNT] {
        if self.eq_on {
            self.gains_db
        } else {
            [0.0; BAND_COUNT]
        }
    }

    /// The linear gain ahead of the filters. Auto headroom takes the largest boost off the preamp, so
    /// a raised curve lowers the signal rather than leaning on the limiter.
    fn gain_target(&self, track_gain_db: f32) -> f32 {
        let boost = self.band_targets().into_iter().fold(0.0f32, f32::max);
        let levelling = match self.levelling {
            Levelling::Off => 0.0,
            Levelling::Track => track_gain_db,
        };
        db_to_gain(self.preamp_db - boost + levelling)
    }
}

/// A gain in dB as a linear factor.
pub(crate) fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
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
/// its own snapshot of the live parameters and re-reads them only at a packet refill. A change glides
/// with a one-pole smoother; the stage's first read lands on its target at once, so a new source
/// applies its settings from sample 0.
pub struct DspStage {
    shared: Arc<DspShared>,
    params: DspParams,
    // The stream layout the filters are tuned for. A zero rate means no packet has been read yet.
    spec: AudioSpec,
    // The track's levelling gain in dB, applied only while levelling is on.
    track_gain_db: f32,
    bypass: bool,
    // Whether the band filters run: some band is or is heading off flat, on a layout the bank holds.
    eq_live: bool,
    gliding: bool,
    // Frames since the band filters were last recomputed during a glide.
    glide_frames: u32,
    // Linear gain on the processing path, and where it is gliding to. f64, so a slow glide near unity
    // never stalls on rounding short of its target.
    gain: f64,
    gain_to: f64,
    gains_db: [f32; BAND_COUNT],
    gains_to: [f32; BAND_COUNT],
    // Per-frame and per-recompute smoothing factors for the current rate.
    k_frame: f64,
    k_ramp: f32,
    bank: Bank,
}

impl DspStage {
    /// A stage reading `shared`. It takes its parameters on the first `refresh`, which tunes it to the
    /// stream's layout.
    pub fn new(shared: Arc<DspShared>, track_gain_db: f32) -> Self {
        Self {
            shared,
            params: DspParams::default(),
            spec: AudioSpec {
                sample_rate: 0,
                channels: 0,
            },
            track_gain_db,
            bypass: true,
            eq_live: false,
            gliding: false,
            glide_frames: 0,
            gain: 1.0,
            gain_to: 1.0,
            gains_db: [0.0; BAND_COUNT],
            gains_to: [0.0; BAND_COUNT],
            k_frame: 1.0,
            k_ramp: 1.0,
            bank: Bank::new(),
        }
    }

    /// Re-reads the live parameters for a stream laid out as `spec`. Called once per packet refill,
    /// never per sample. A layout change retunes the filters; a parameter change starts a glide.
    pub fn refresh(&mut self, spec: AudioSpec) {
        let params = self.shared.load();
        let first = self.spec.sample_rate == 0;
        if !first && params == self.params && spec == self.spec {
            return;
        }
        if spec != self.spec {
            if spec.channels != self.spec.channels {
                self.bank.reset();
            }
            self.spec = spec;
            self.k_frame = smoothing(1, spec.sample_rate);
            self.k_ramp = smoothing(RAMP_FRAMES, spec.sample_rate) as f32;
        }
        self.params = params;
        self.gains_to = params.band_targets();
        self.gain_to = params.gain_target(self.track_gain_db) as f64;
        if first {
            self.settle();
        } else if self.gains_to != self.gains_db || self.gain_to != self.gain {
            self.gliding = true;
            self.glide_frames = 0;
            self.bypass = false;
            self.eq_live = self.bank_fits();
            self.bank.set(&self.gains_db, spec.sample_rate);
        } else {
            self.bank.set(&self.gains_db, spec.sample_rate);
        }
    }

    /// Processes one interleaved sample of `channel`. Bypassed, it returns `s` unchanged.
    #[inline]
    pub fn process(&mut self, s: f32, channel: u16) -> f32 {
        if channel == 0 && self.gliding {
            self.step();
        }
        if self.bypass {
            return s;
        }
        // An f32 sample times an f32-valued gain is exact in f64, so without the filters this rounds
        // to the plain f32 product.
        let x = s as f64 * self.gain;
        let y = if self.eq_live {
            self.bank.process(x, channel as usize)
        } else {
            x
        };
        limiter::soft_limit(y as f32)
    }

    /// Advances a glide by one frame, recomputing the band filters every RAMP_FRAMES frames and
    /// settling once every value is within reach of its target.
    fn step(&mut self) {
        self.gain += (self.gain_to - self.gain) * self.k_frame;
        self.glide_frames += 1;
        if self.glide_frames < RAMP_FRAMES {
            return;
        }
        self.glide_frames = 0;
        let mut settled = (self.gain_to - self.gain).abs() <= SETTLE_GAIN;
        for (g, to) in self.gains_db.iter_mut().zip(self.gains_to) {
            *g += (to - *g) * self.k_ramp;
            settled &= (to - *g).abs() <= SETTLE_DB;
        }
        if settled {
            self.settle();
        } else {
            self.bank.set(&self.gains_db, self.spec.sample_rate);
        }
    }

    /// Lands every value on its target and ends any glide. A flat curve stops the filters and clears
    /// their memory, and an identity set bypasses the stage.
    fn settle(&mut self) {
        self.gain = self.gain_to;
        self.gains_db = self.gains_to;
        self.gliding = false;
        self.glide_frames = 0;
        self.bank.set(&self.gains_db, self.spec.sample_rate);
        let flat = self.gains_db == [0.0; BAND_COUNT];
        if flat {
            self.bank.reset();
        }
        self.eq_live = !flat && self.bank_fits();
        self.bypass = self.params.is_identity();
    }

    fn bank_fits(&self) -> bool {
        (self.spec.channels as usize) <= MAX_CHANNELS
    }

    /// A stage on a fixed preamp, to observe where the stage sits in a source.
    #[cfg(test)]
    pub(crate) fn with_preamp(preamp_db: f32) -> Self {
        let shared = Arc::new(DspShared::default());
        shared.store(&DspParams {
            preamp_db,
            ..DspParams::default()
        });
        Self::new(shared, 0.0)
    }
}

/// The one-pole factor that covers `frames` frames of a GLIDE_SECS time constant at `rate`. A zero
/// rate snaps.
fn smoothing(frames: u32, rate: u32) -> f64 {
    if rate == 0 {
        return 1.0;
    }
    1.0 - (-(frames as f64) / (GLIDE_SECS * rate as f64)).exp()
}

#[cfg(test)]
mod tests {
    use super::*;

    const STEREO_44K: AudioSpec = AudioSpec {
        sample_rate: 44_100,
        channels: 2,
    };

    // A primed stage on `shared`, as a source builds one.
    fn primed(shared: &Arc<DspShared>, spec: AudioSpec) -> DspStage {
        let mut stage = DspStage::new(Arc::clone(shared), 0.0);
        stage.refresh(spec);
        stage
    }

    fn eq(gains_db: [f32; BAND_COUNT]) -> DspParams {
        DspParams {
            eq_on: true,
            gains_db,
            ..DspParams::default()
        }
    }

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
        let mut bass = [0.0; BAND_COUNT];
        bass[0] = 3.0;
        let preamp = DspParams {
            preamp_db: -1.0,
            ..DspParams::default()
        };
        let levelling = DspParams {
            levelling: Levelling::Track,
            ..DspParams::default()
        };
        assert!(!eq(bass).is_identity());
        assert!(!preamp.is_identity());
        assert!(!levelling.is_identity());
        // A curve with the EQ switched off does nothing.
        assert!(DspParams {
            eq_on: false,
            ..eq(bass)
        }
        .is_identity());
    }

    #[test]
    fn a_bypassed_stage_returns_the_sample_bits() {
        let mut stage = primed(&Arc::new(DspShared::default()), STEREO_44K);
        for s in [0.0f32, -0.0, 1.0, -1.0, 0.123_456_79, f32::MIN_POSITIVE] {
            assert_eq!(stage.process(s, 0).to_bits(), s.to_bits());
        }
    }

    #[test]
    fn a_flat_eq_is_bit_exact() {
        let shared = Arc::new(DspShared::default());
        shared.store(&eq([0.0; BAND_COUNT]));
        let mut stage = primed(&shared, STEREO_44K);
        // Over full scale too: a flat EQ does not bring in the limiter.
        for (i, s) in [0.0f32, -0.0, 0.5, -0.99, 1.0, 1.7, -3.2, f32::MIN_POSITIVE]
            .into_iter()
            .enumerate()
        {
            assert_eq!(stage.process(s, (i % 2) as u16).to_bits(), s.to_bits());
        }
    }

    #[test]
    fn refresh_picks_up_a_new_set() {
        let shared = Arc::new(DspShared::default());
        let mut stage = primed(&shared, STEREO_44K);
        assert!(stage.bypass);
        shared.store(&DspParams {
            preamp_db: -6.0,
            ..DspParams::default()
        });
        assert!(stage.bypass, "the stage holds its snapshot until a refresh");
        stage.refresh(STEREO_44K);
        assert!(!stage.bypass);
    }

    #[test]
    fn a_new_stage_starts_at_its_target() {
        let shared = Arc::new(DspShared::default());
        shared.store(&DspParams {
            preamp_db: -6.0,
            ..DspParams::default()
        });
        let mut stage = primed(&shared, STEREO_44K);
        assert!(!stage.gliding);
        assert_eq!(stage.process(0.5, 0), 0.5 * db_to_gain(-6.0));
    }

    #[test]
    fn auto_headroom_takes_the_largest_boost_off_the_preamp() {
        let mut gains = [0.0; BAND_COUNT];
        gains[2] = 4.0;
        gains[5] = 9.0;
        gains[6] = -12.0;
        let p = DspParams {
            preamp_db: 2.0,
            ..eq(gains)
        };
        assert_eq!(p.gain_target(0.0), db_to_gain(2.0 - 9.0));
        // A cut-only curve takes nothing.
        let cut = DspParams {
            preamp_db: 2.0,
            ..eq([-3.0; BAND_COUNT])
        };
        assert_eq!(cut.gain_target(0.0), db_to_gain(2.0));
        // Levelling adds the track gain only while it is on.
        let levelled = DspParams {
            levelling: Levelling::Track,
            ..p
        };
        assert_eq!(levelled.gain_target(-5.0), db_to_gain(2.0 - 9.0 - 5.0));
        assert_eq!(p.gain_target(-5.0), db_to_gain(2.0 - 9.0));
    }

    #[test]
    fn a_gain_step_glides_with_a_bounded_per_sample_delta() {
        let shared = Arc::new(DspShared::default());
        let mut stage = primed(&shared, STEREO_44K);
        // Preamp down 12 dB and a 12 dB bass shelf at once, on a steady signal.
        let mut gains = [0.0; BAND_COUNT];
        gains[0] = 12.0;
        shared.store(&DspParams {
            preamp_db: -12.0,
            ..eq(gains)
        });
        stage.refresh(STEREO_44K);
        assert!(stage.gliding);

        let input = 0.5f32;
        let mut prev = stage.process(input, 0);
        stage.process(input, 1);
        let mut max_delta = 0.0f32;
        for _ in 0..STEREO_44K.sample_rate {
            let y = stage.process(input, 0);
            stage.process(input, 1);
            max_delta = max_delta.max((y - prev).abs());
            prev = y;
        }
        assert!(!stage.gliding, "the glide settles within a second");
        // A hard step would jump by most of the input in one sample.
        assert!(max_delta < 2e-3, "max per-sample delta {max_delta}");
        // DC sees the shelf's full boost and the preamp's cut plus the 12 dB of headroom.
        let expected = input * db_to_gain(12.0 - 12.0 - 12.0);
        assert!((prev - expected).abs() < 1e-3, "{prev} vs {expected}");
    }

    #[test]
    fn a_glide_back_to_identity_ends_bypassed() {
        let shared = Arc::new(DspShared::default());
        shared.store(&DspParams {
            preamp_db: -6.0,
            ..DspParams::default()
        });
        let mut stage = primed(&shared, STEREO_44K);
        shared.store(&DspParams::default());
        stage.refresh(STEREO_44K);
        assert!(stage.gliding && !stage.bypass);
        for _ in 0..STEREO_44K.sample_rate {
            stage.process(0.25, 0);
            stage.process(0.25, 1);
        }
        assert!(stage.bypass);
        assert_eq!(stage.process(1.5, 0), 1.5);
    }

    #[test]
    fn the_eq_bypasses_past_eight_channels() {
        let shared = Arc::new(DspShared::default());
        let mut gains = [0.0; BAND_COUNT];
        gains[3] = 6.0;
        shared.store(&eq(gains));
        let wide = AudioSpec {
            sample_rate: 48_000,
            channels: 10,
        };
        let stage = primed(&shared, wide);
        assert!(!stage.eq_live);
        assert!(primed(&shared, STEREO_44K).eq_live);
    }

    #[test]
    fn the_seqlock_never_yields_a_torn_set() {
        // Every written set holds one value in every field, so any mix of two writes shows.
        fn set(i: u32) -> DspParams {
            let v = (i % 1000) as f32;
            DspParams {
                eq_on: i % 2 == 1,
                gains_db: [v; BAND_COUNT],
                preamp_db: v,
                levelling: if i % 2 == 1 {
                    Levelling::Track
                } else {
                    Levelling::Off
                },
            }
        }
        let shared = DspShared::default();
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for i in 0..200_000 {
                    shared.store(&set(i));
                }
                done.store(true, Ordering::Release);
            });
            let mut reads = 0u32;
            while !done.load(Ordering::Acquire) || reads < 1000 {
                let p = shared.load();
                let i = p.preamp_db as u32;
                assert!(p.gains_db.iter().all(|g| *g == p.preamp_db), "torn: {p:?}");
                assert_eq!(p.eq_on, i % 2 == 1, "torn: {p:?}");
                assert_eq!(p.levelling == Levelling::Track, p.eq_on, "torn: {p:?}");
                reads += 1;
            }
        });
    }
}
