/*
 * The `levels` page events: ten a second while the plugin's page is open, none while it is closed.
 * Plisto drops page events for a closed page anyway; not sending them saves the work and the pipe.
 */

// -- Library Imports --
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// -- Local Imports --
use crate::meter::Window;

/// The page event topic the page subscribes to.
pub const LEVELS_TOPIC: &str = "levels";
pub const LEVELS_EVERY: Duration = Duration::from_millis(100);

/// What to do at one tick of the reporter.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Step {
    /// The page was just shown (`true`) or hidden (`false`).
    pub changed: Option<bool>,
    /// Send a `levels` event now.
    pub send: bool,
}

#[derive(Default)]
pub struct LevelEvents {
    open: bool,
    next: Option<Instant>,
}

impl LevelEvents {
    pub fn tick(&mut self, open: bool, now: Instant) -> Step {
        let changed = (open != self.open).then_some(open);
        self.open = open;
        if !open {
            self.next = None;
            return Step {
                changed,
                send: false,
            };
        }
        let due = self.next.is_none_or(|next| now >= next);
        if due {
            self.next = Some(now + LEVELS_EVERY);
        }
        Step { changed, send: due }
    }
}

/// The data of a `levels` event: per channel peak and RMS in dBFS, null for a channel with no samples.
pub fn levels_data(window: &Window, transport: Option<&str>) -> Value {
    json!({
        "peak_db": window.peak_db,
        "rms_db": window.rms_db,
        "transport": transport,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_sent_while_the_page_is_closed() {
        let t0 = Instant::now();
        let mut events = LevelEvents::default();
        for ms in [0, 100, 250, 1000] {
            let step = events.tick(false, t0 + Duration::from_millis(ms));
            assert_eq!(step, Step::default());
        }
    }

    #[test]
    fn an_open_page_gets_ten_a_second_and_a_close_stops_them() {
        let t0 = Instant::now();
        let mut events = LevelEvents::default();
        assert_eq!(
            events.tick(true, t0),
            Step {
                changed: Some(true),
                send: true
            }
        );
        let mut sent = 1;
        for ms in (20..=1000).step_by(20) {
            if events.tick(true, t0 + Duration::from_millis(ms)).send {
                sent += 1;
            }
        }
        assert_eq!(sent, 11);
        let closed = events.tick(false, t0 + Duration::from_millis(1020));
        assert_eq!(
            closed,
            Step {
                changed: Some(false),
                send: false
            }
        );
        // Reopened, it sends at once.
        assert!(events.tick(true, t0 + Duration::from_millis(1030)).send);
    }

    #[test]
    fn the_data_has_one_entry_per_channel() {
        let window = Window {
            peak_db: vec![Some(-6.0), None],
            rms_db: vec![Some(-9.0), None],
        };
        assert_eq!(
            levels_data(&window, Some("playing")),
            json!({"peak_db": [-6.0, null], "rms_db": [-9.0, null], "transport": "playing"})
        );
    }
}
