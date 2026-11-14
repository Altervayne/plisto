/*
 * The crash policy for one supervised plugin, pure and driven by the instants it is given. Restart
 * delays grow with the crashes since the last run that stayed up a full minute; three crashes inside
 * any minute turn the plugin off instead. The two rules count different things, so a plugin that
 * crashes once an hour restarts forever after a short delay, while one stuck in a quick loop stops.
 */

// -- Library Imports --
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Restart delays by crash streak: the first, the second, then every later one.
pub const BACKOFF: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];
/// `CRASH_LIMIT` crashes inside this window turn the plugin off.
pub const CRASH_WINDOW: Duration = Duration::from_secs(60);
pub const CRASH_LIMIT: usize = 3;
/// A run that stays up this long resets the streak.
pub const STABLE_RUN: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    RestartIn(Duration),
    /// Too many crashes: the plugin is turned off.
    CrashLoop,
}

#[derive(Debug, Default)]
pub struct CrashPolicy {
    crashes: VecDeque<Instant>,
    streak: u32,
    up_since: Option<Instant>,
}

impl CrashPolicy {
    /// The plugin is up from `now`.
    pub fn on_running(&mut self, now: Instant) {
        self.up_since = Some(now);
    }

    pub fn on_crash(&mut self, now: Instant) -> Verdict {
        if self
            .up_since
            .take()
            .is_some_and(|up| now.saturating_duration_since(up) >= STABLE_RUN)
        {
            self.streak = 0;
        }
        self.streak += 1;
        while self
            .crashes
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= CRASH_WINDOW)
        {
            self.crashes.pop_front();
        }
        self.crashes.push_back(now);
        if self.crashes.len() >= CRASH_LIMIT {
            return Verdict::CrashLoop;
        }
        let step = (self.streak as usize).min(BACKOFF.len()) - 1;
        Verdict::RestartIn(BACKOFF[step])
    }

    /// Forgets every crash, for a restart or an enable the user asked for.
    pub fn reset(&mut self) {
        *self = CrashPolicy::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn delays_grow_one_two_four_by_streak() {
        let t0 = Instant::now();
        let mut policy = CrashPolicy::default();
        // Crashes spaced over a minute apart never loop, so the streak alone sets the delay.
        let delays: Vec<Verdict> = (0..5).map(|n| policy.on_crash(t0 + secs(61 * n))).collect();
        assert_eq!(
            delays,
            [
                Verdict::RestartIn(secs(1)),
                Verdict::RestartIn(secs(2)),
                Verdict::RestartIn(secs(4)),
                Verdict::RestartIn(secs(4)),
                Verdict::RestartIn(secs(4)),
            ]
        );
    }

    #[test]
    fn a_run_that_stays_up_a_minute_resets_the_streak() {
        let t0 = Instant::now();
        let mut policy = CrashPolicy::default();
        assert_eq!(policy.on_crash(t0), Verdict::RestartIn(secs(1)));
        policy.on_running(t0 + secs(1));
        assert_eq!(policy.on_crash(t0 + secs(30)), Verdict::RestartIn(secs(2)));
        policy.on_running(t0 + secs(32));
        // Up for exactly the stable run.
        assert_eq!(policy.on_crash(t0 + secs(92)), Verdict::RestartIn(secs(1)));
        policy.on_running(t0 + secs(93));
        // One second short of it.
        assert_eq!(policy.on_crash(t0 + secs(152)), Verdict::RestartIn(secs(2)));
    }

    #[test]
    fn the_third_crash_inside_a_minute_is_a_crash_loop() {
        let t0 = Instant::now();
        let mut policy = CrashPolicy::default();
        assert_eq!(policy.on_crash(t0), Verdict::RestartIn(secs(1)));
        assert_eq!(policy.on_crash(t0 + secs(2)), Verdict::RestartIn(secs(2)));
        assert_eq!(policy.on_crash(t0 + secs(59)), Verdict::CrashLoop);
    }

    #[test]
    fn crashes_older_than_the_window_do_not_count() {
        let t0 = Instant::now();
        let mut policy = CrashPolicy::default();
        policy.on_crash(t0);
        policy.on_crash(t0 + secs(30));
        // The first crash is exactly a window old: two remain inside it.
        assert_eq!(policy.on_crash(t0 + secs(60)), Verdict::RestartIn(secs(4)));
        assert_eq!(policy.on_crash(t0 + secs(61)), Verdict::CrashLoop);
    }

    #[test]
    fn reset_forgets_the_streak_and_the_window() {
        let t0 = Instant::now();
        let mut policy = CrashPolicy::default();
        policy.on_crash(t0);
        policy.on_crash(t0 + secs(1));
        policy.reset();
        assert_eq!(policy.on_crash(t0 + secs(2)), Verdict::RestartIn(secs(1)));
        assert_eq!(policy.on_crash(t0 + secs(3)), Verdict::RestartIn(secs(2)));
    }
}
