/*
 * Holding Plisto's local output. tap-meter asks once per run, right after `ready`, and never again in
 * that run: a denial, a refusal or a release by Plisto (the user, a missed heartbeat, a stop) stands
 * until the next launch. No user action is needed for a grant: the user consented to
 * `audio.output_takeover` at install. A hold lives in memory only, on both sides.
 *
 * Plisto may send the same state twice: a state its outbox had no room for goes out again after the
 * next valid `pong`, and a release for missed pings is always repeated once the plugin answers again.
 * A repeat changes nothing and is logged as one.
 */

// -- Local Imports --
use crate::protocol::{ChildMessage, LogLevel, TakeoverReason};

#[derive(Debug, Default)]
pub struct Takeover {
    asked: bool,
    held: bool,
    last: Option<(bool, TakeoverReason)>,
}

/// The wire name of a reason, as the log shows it.
pub fn reason_name(reason: TakeoverReason) -> &'static str {
    match reason {
        TakeoverReason::Granted => "granted",
        TakeoverReason::Released => "released",
        TakeoverReason::Denied => "denied",
        TakeoverReason::Busy => "busy",
        TakeoverReason::User => "user",
        TakeoverReason::NotResponding => "not_responding",
        TakeoverReason::Stopped => "stopped",
    }
}

impl Takeover {
    /// The request, the first time only.
    pub fn request(&mut self) -> Option<ChildMessage> {
        if self.asked {
            return None;
        }
        self.asked = true;
        Some(ChildMessage::Takeover { hold: true })
    }

    /// Takes a `takeover_state` and returns its log line.
    pub fn update(&mut self, held: bool, reason: TakeoverReason) -> (LogLevel, String) {
        self.held = held;
        if self.last.replace((held, reason)) == Some((held, reason)) {
            let line = format!(
                "takeover_state {} (held {held}) again: no change",
                reason_name(reason)
            );
            return (LogLevel::Debug, line);
        }
        let (level, meaning) = match reason {
            TakeoverReason::Granted => (
                LogLevel::Info,
                "holding Plisto's output; its own speakers are muted",
            ),
            TakeoverReason::Released => (LogLevel::Info, "released at this plugin's request"),
            TakeoverReason::Denied => (
                LogLevel::Warn,
                "refused: audio.output_takeover is not granted, the plugin is not running, or the ask came from a run that has ended",
            ),
            TakeoverReason::Busy => (LogLevel::Warn, "refused: another plugin holds the output"),
            TakeoverReason::User => (
                LogLevel::Info,
                "taken back by the user; not asking again this run",
            ),
            TakeoverReason::NotResponding => (
                LogLevel::Warn,
                "taken back after missed pings; not asking again this run",
            ),
            TakeoverReason::Stopped => (LogLevel::Info, "taken back: the plugin is stopping"),
        };
        let line = format!(
            "takeover_state {} (held {held}): {meaning}",
            reason_name(reason)
        );
        (level, line)
    }

    pub fn held(&self) -> bool {
        self.held
    }

    /// The release to send on a clean exit, when the output is still held.
    pub fn release(&mut self) -> Option<ChildMessage> {
        self.held.then(|| {
            self.held = false;
            ChildMessage::Takeover { hold: false }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [TakeoverReason; 7] = [
        TakeoverReason::Granted,
        TakeoverReason::Released,
        TakeoverReason::Denied,
        TakeoverReason::Busy,
        TakeoverReason::User,
        TakeoverReason::NotResponding,
        TakeoverReason::Stopped,
    ];

    #[test]
    fn the_output_is_asked_for_once_per_run() {
        let mut t = Takeover::default();
        assert_eq!(t.request(), Some(ChildMessage::Takeover { hold: true }));
        t.update(true, TakeoverReason::Granted);
        t.update(false, TakeoverReason::User);
        assert_eq!(t.request(), None);
        // A denial is not retried either.
        let mut denied = Takeover::default();
        denied.request();
        denied.update(false, TakeoverReason::Denied);
        assert_eq!(denied.request(), None);
    }

    #[test]
    fn every_reason_is_logged_by_its_wire_name() {
        for reason in ALL {
            let mut t = Takeover::default();
            let held = reason == TakeoverReason::Granted;
            let (_, line) = t.update(held, reason);
            let name = serde_json::to_value(reason).unwrap();
            assert_eq!(reason_name(reason), name.as_str().unwrap());
            assert!(
                line.starts_with(&format!(
                    "takeover_state {} (held {held})",
                    reason_name(reason)
                )),
                "{line}"
            );
            assert_eq!(t.held(), held);
        }
    }

    #[test]
    fn refusals_and_a_missed_heartbeat_are_warnings() {
        let mut t = Takeover::default();
        for reason in ALL {
            let (level, _) = t.update(false, reason);
            let warn = matches!(
                reason,
                TakeoverReason::Denied | TakeoverReason::Busy | TakeoverReason::NotResponding
            );
            assert_eq!(level == LogLevel::Warn, warn, "{reason:?}");
        }
    }

    #[test]
    fn a_repeated_state_changes_nothing_and_says_so() {
        let mut t = Takeover::default();
        t.request();
        t.update(true, TakeoverReason::Granted);
        let (_, first) = t.update(false, TakeoverReason::NotResponding);
        assert!(first.ends_with("not asking again this run"));
        // Sent again by Plisto after the next valid pong.
        let (level, again) = t.update(false, TakeoverReason::NotResponding);
        assert_eq!(level, LogLevel::Debug);
        assert_eq!(
            again,
            "takeover_state not_responding (held false) again: no change"
        );
        assert!(!t.held());
        assert_eq!(t.release(), None);
    }

    #[test]
    fn a_hold_ended_by_silence_is_not_asked_for_again_after_recovery() {
        let mut t = Takeover::default();
        assert!(t.request().is_some());
        t.update(true, TakeoverReason::Granted);
        t.update(false, TakeoverReason::NotResponding);
        t.update(false, TakeoverReason::NotResponding);
        assert_eq!(t.request(), None);
        assert!(!t.held());
    }

    #[test]
    fn a_denied_or_busy_ask_holds_nothing() {
        for reason in [TakeoverReason::Denied, TakeoverReason::Busy] {
            let mut t = Takeover::default();
            t.request();
            let (level, _) = t.update(false, reason);
            assert_eq!(level, LogLevel::Warn);
            assert!(!t.held());
            assert_eq!(t.release(), None);
            assert_eq!(t.request(), None);
        }
    }

    #[test]
    fn a_held_output_is_released_on_exit_and_only_then() {
        let mut t = Takeover::default();
        assert_eq!(t.release(), None);
        t.request();
        t.update(true, TakeoverReason::Granted);
        assert_eq!(t.release(), Some(ChildMessage::Takeover { hold: false }));
        assert_eq!(t.release(), None);
        t.update(false, TakeoverReason::Stopped);
        assert_eq!(t.release(), None);
    }
}
