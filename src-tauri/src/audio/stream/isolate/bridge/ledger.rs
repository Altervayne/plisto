/*
 * The watchdog's accounts, kept apart from any clock, job or atomic so every rule can be checked
 * with made-up numbers. The helper is paid in CPU for audio it delivers.
 *
 * Spin: a credit of CPU, starting full at the spin budget and never above it. Each CPU reading adds
 * the idle allowance for the wall time since the last one and the audio allowance for the audio
 * main accepted since, then takes the CPU the helper used; CPU the credit cannot cover is a spin.
 * A new seek main sent fills the credit: the work it asks for is main's, not the helper's.
 *
 * Stall: a debt of wall time. It grows while main waits on the helper, shrinks by `payback` times
 * the audio main accepts, and is cleared by a new seek main sent; it is a hang at the stall time.
 * A step of the stall clock adds at most `step_max`, so a late check, after the machine slept or
 * the bridge thread starved, never charges the helper for the gap.
 */

// -- Library Imports --
use std::time::Duration;

// -- Local Imports --
use crate::audio::stream::Fault;

/// What the accounts allow one helper.
#[derive(Clone, Copy, Debug)]
pub(super) struct Limits {
    /// The spin credit's size, and where it starts.
    pub(super) spin: Duration,
    /// The debt that is a hang.
    pub(super) stall: Duration,
    /// CPU allowed per second of wall time.
    pub(super) idle_per_sec: Duration,
    /// CPU allowed per second of audio main accepts.
    pub(super) per_audio_sec: Duration,
    /// Debt paid off per second of audio main accepts, in seconds.
    pub(super) payback: u32,
    /// The most one step of the stall clock adds.
    pub(super) step_max: Duration,
}

pub(super) struct Ledger {
    limits: Limits,
    credit: Duration,
    owed: Duration,
    // The newest seek generation main sent that filled the credit.
    seek: u64,
}

// `per_sec` for each second of `span`, saturating.
fn rate(per_sec: Duration, span: Duration) -> Duration {
    Duration::try_from_secs_f64(per_sec.as_secs_f64() * span.as_secs_f64()).unwrap_or(Duration::MAX)
}

impl Ledger {
    pub(super) fn new(limits: Limits) -> Ledger {
        Ledger {
            limits,
            credit: limits.spin,
            owed: Duration::ZERO,
            seek: 0,
        }
    }

    /// A seek main sent, by generation. Only a generation newer than any seen fills the credit and
    /// clears the debt: a seek handed back again is the same work.
    pub(super) fn seek(&mut self, generation: u64) {
        if generation > self.seek {
            self.seek = generation;
            self.credit = self.limits.spin;
            self.owed = Duration::ZERO;
        }
    }

    /// One CPU reading: `wall` since the last one, the helper's `used` CPU and the `audio` main
    /// accepted meanwhile.
    pub(super) fn reading(
        &mut self,
        wall: Duration,
        used: Duration,
        audio: Duration,
    ) -> Option<Fault> {
        let earned = rate(self.limits.idle_per_sec, wall)
            .saturating_add(rate(self.limits.per_audio_sec, audio));
        self.credit = self.credit.saturating_add(earned).min(self.limits.spin);
        if used > self.credit {
            return Some(Fault::Spun);
        }
        self.credit -= used;
        None
    }

    /// One step of the stall clock: `elapsed` since the last, whether main is the one holding
    /// things up, and the `audio` main accepted meanwhile.
    pub(super) fn tick(
        &mut self,
        elapsed: Duration,
        main_holds: bool,
        audio: Duration,
    ) -> Option<Fault> {
        if !main_holds {
            self.owed = self.owed.saturating_add(elapsed.min(self.limits.step_max));
        }
        self.owed = self
            .owed
            .saturating_sub(audio.saturating_mul(self.limits.payback));
        (self.owed >= self.limits.stall).then_some(Fault::Hung)
    }
}

#[cfg(test)]
mod tests;
