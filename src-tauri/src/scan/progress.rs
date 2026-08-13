/*
 * The pure decision behind progress emission: emit at most once per interval, but always emit
 * the terminal tick. The clock is injected as a millisecond value so the rule is deterministic
 * and testable without threads or real time. The live emitter polls faster than the interval
 * and leans on this to coalesce the wakeups into steady ticks.
 */

/// Gates progress emits to one per `interval_ms`, with a guaranteed emit on the terminal tick.
pub struct ProgressThrottle {
    interval_ms: u64,
    last_emit_ms: Option<u64>,
}

impl ProgressThrottle {
    pub fn new(interval_ms: u64) -> Self {
        Self {
            interval_ms,
            last_emit_ms: None,
        }
    }

    /// Decides whether to emit at `now_ms`. A terminal tick always emits. A periodic tick emits
    /// only once `interval_ms` has elapsed since the last emit. Records the time whenever it
    /// returns true, so the next gap is measured from here.
    pub fn should_emit(&mut self, now_ms: u64, terminal: bool) -> bool {
        if terminal {
            self.last_emit_ms = Some(now_ms);
            return true;
        }
        match self.last_emit_ms {
            Some(last) if now_ms.saturating_sub(last) < self.interval_ms => false,
            _ => {
                self.last_emit_ms = Some(now_ms);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_tick_always_emits() {
        let mut t = ProgressThrottle::new(100);
        assert!(t.should_emit(0, false));
    }

    #[test]
    fn a_burst_within_the_interval_emits_a_bounded_count() {
        let mut t = ProgressThrottle::new(100);
        let mut emits = 0;
        // 1000 wakeups across 500ms of virtual time: one emit at each 100ms boundary.
        for step in 0..1000u64 {
            let now = step / 2; // two wakeups per virtual millisecond
            if t.should_emit(now, false) {
                emits += 1;
            }
        }
        // Emits land at 0, 100, 200, 300, 400: six boundaries at most across the span.
        assert!(emits <= 6, "expected coalesced emits, got {emits}");
        assert!(emits >= 5, "expected steady emits across the span, got {emits}");
    }

    #[test]
    fn terminal_always_emits_even_inside_the_interval() {
        let mut t = ProgressThrottle::new(100);
        assert!(t.should_emit(0, false));
        // Well inside the interval a periodic tick is suppressed...
        assert!(!t.should_emit(10, false));
        // ...but the terminal tick still fires.
        assert!(t.should_emit(20, true));
    }

    #[test]
    fn a_run_yields_exactly_one_terminal_emit() {
        let mut t = ProgressThrottle::new(100);
        let mut terminals = 0;
        for step in 0..50u64 {
            let terminal = step == 49;
            if t.should_emit(step, terminal) && terminal {
                terminals += 1;
            }
        }
        assert_eq!(terminals, 1);
    }
}
