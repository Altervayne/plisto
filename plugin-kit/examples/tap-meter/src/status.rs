/*
 * The `status` line tap-meter reports: which of Plisto's three states fits what the tap is doing, the text
 * beside it, and the gate that lets a line out only when it changed and at most once a second. Plisto
 * applies one status per second anyway, so sending more would only be dropped. Nothing here does I/O.
 */

// -- Library Imports --
use std::time::{Duration, Instant};

// -- Local Imports --
use crate::meter::{peak_text, Window};
use crate::protocol::{clean_status_text, ReportedState};

/// The least time between two `status` messages.
pub const MIN_INTERVAL: Duration = Duration::from_secs(1);

/// Where the tap stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TapState {
    /// Plisto passed no tap name.
    Missing,
    /// There is a name, but the mapping is not open.
    Closed,
    Open,
}

/// A state and its text. The text is cleaned on construction, so a line can always be sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub state: ReportedState,
    pub text: Option<String>,
}

impl Line {
    pub fn new(state: ReportedState, text: &str) -> Self {
        Self {
            state,
            text: clean_status_text(text),
        }
    }
}

/// `on` while audio plays through the tap, `idle` while it is paused, stopped, buffering or silent, `warn`
/// while there is no tap to read. `transport` is the last playback state from the feed, if any arrived.
/// While the plugin holds Plisto's output the text says so first, since Plisto shows it beside the
/// takeover.
pub fn line(tap: TapState, transport: Option<&str>, window: &Window, held: bool) -> Line {
    let (state, text) = match tap {
        TapState::Missing => (ReportedState::Warn, "no tap".to_string()),
        TapState::Closed => (ReportedState::Warn, "tap not open".to_string()),
        TapState::Open => match (transport, peak_text(window)) {
            (Some(state @ ("paused" | "stopped" | "buffering")), _) => {
                (ReportedState::Idle, state.to_string())
            }
            (_, Some(peak)) => (ReportedState::On, peak),
            _ => (ReportedState::Idle, "silent".to_string()),
        },
    };
    if held {
        return Line::new(state, &format!("holding output; {text}"));
    }
    Line::new(state, &text)
}

/// Lets a line through when it differs from the last one sent and a second has passed since that send.
#[derive(Default)]
pub struct Gate {
    sent: Option<(Line, Instant)>,
}

impl Gate {
    /// The line to send now, if any. A change held back is offered again by the next call.
    pub fn offer(&mut self, line: Line, now: Instant) -> Option<Line> {
        if let Some((last, at)) = &self.sent {
            if *last == line || now.duration_since(*at) < MIN_INTERVAL {
                return None;
            }
        }
        self.sent = Some((line.clone(), now));
        Some(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{status_text_ok, STATUS_TEXT_MAX_CHARS};

    fn audible() -> Window {
        Window {
            peak_db: vec![Some(-6.0), Some(-12.0)],
            rms_db: vec![Some(-9.0), Some(-15.0)],
        }
    }

    fn silent() -> Window {
        Window {
            peak_db: vec![None, None],
            rms_db: vec![None, None],
        }
    }

    #[test]
    fn no_tap_is_a_warning() {
        let missing = line(TapState::Missing, Some("playing"), &audible(), false);
        assert_eq!(missing, Line::new(ReportedState::Warn, "no tap"));
        let closed = line(TapState::Closed, None, &silent(), false);
        assert_eq!(closed.state, ReportedState::Warn);
    }

    #[test]
    fn audio_through_the_tap_is_on() {
        let on = line(TapState::Open, Some("playing"), &audible(), false);
        assert_eq!(on, Line::new(ReportedState::On, "peak -6.0 -12.0 dB"));
        // Without a feed, audio in the tap is still audio.
        assert_eq!(
            line(TapState::Open, None, &audible(), false).state,
            ReportedState::On
        );
    }

    #[test]
    fn paused_stopped_buffering_and_silent_are_idle() {
        for transport in ["paused", "stopped", "buffering"] {
            let idle = line(TapState::Open, Some(transport), &audible(), false);
            assert_eq!(idle, Line::new(ReportedState::Idle, transport));
        }
        let silence = line(TapState::Open, Some("playing"), &silent(), false);
        assert_eq!(silence, Line::new(ReportedState::Idle, "silent"));
    }

    #[test]
    fn a_held_output_leads_the_text() {
        let held = line(TapState::Open, Some("playing"), &audible(), true);
        assert_eq!(
            held,
            Line::new(ReportedState::On, "holding output; peak -6.0 -12.0 dB")
        );
        let paused = line(TapState::Open, Some("paused"), &audible(), true);
        assert_eq!(paused.state, ReportedState::Idle);
    }

    #[test]
    fn a_line_never_carries_a_text_the_host_would_refuse() {
        let many = Window {
            peak_db: vec![Some(-100.5); 32],
            rms_db: vec![Some(-100.5); 32],
        };
        let long = line(TapState::Open, Some("playing"), &many, false);
        let text = long.text.expect("has a text");
        assert!(status_text_ok(&text));
        assert!(text.chars().count() <= STATUS_TEXT_MAX_CHARS);
        assert_eq!(Line::new(ReportedState::On, "\n\t").text, None);
    }

    #[test]
    fn the_gate_sends_a_change_and_not_a_repeat() {
        let t0 = Instant::now();
        let mut gate = Gate::default();
        let a = Line::new(ReportedState::Idle, "silent");
        let b = Line::new(ReportedState::On, "peak -6.0 dB");
        assert_eq!(gate.offer(a.clone(), t0), Some(a.clone()));
        let later = t0 + Duration::from_secs(5);
        assert_eq!(gate.offer(a, later), None);
        assert_eq!(gate.offer(b.clone(), later), Some(b));
    }

    #[test]
    fn the_gate_allows_one_line_a_second() {
        let t0 = Instant::now();
        let mut gate = Gate::default();
        let a = Line::new(ReportedState::Idle, "silent");
        let b = Line::new(ReportedState::On, "peak -6.0 dB");
        assert!(gate.offer(a, t0).is_some());
        let soon = t0 + Duration::from_millis(900);
        assert_eq!(gate.offer(b.clone(), soon), None);
        // The held change goes out once the second is up.
        let due = t0 + MIN_INTERVAL;
        assert_eq!(gate.offer(b.clone(), due), Some(b));
    }
}
