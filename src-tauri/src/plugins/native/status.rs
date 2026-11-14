/*
 * The status of every supervised plugin as the main window shows it: Plisto's host state for the
 * plugin, what a native child last reported, and its last crash. Every change bumps the plugin's `rev`,
 * which only grows, so the window drops an event older than the one it holds; entries are never removed
 * for that reason. Host-state changes go out at once. A child's reported state is applied at most once
 * a second, the latest value winning, so a child flipping states cannot make its dot flash. Emits per
 * plugin are capped too. A change held back by either rule is flushed by the supervisor's tick, so the
 * last value always goes out.
 */

// -- Library Imports --
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use serde::Serialize;

// -- Local Imports --
use super::link::HostLink;
use super::protocol::{ReportedState, TakeoverReason};
use crate::scan::progress::ProgressThrottle;

/// A reported change is applied at most once per this many milliseconds.
pub const REPORT_EVERY_MS: u64 = 1_000;
/// Status events per plugin within any second.
pub const EMITS_PER_SEC: usize = 4;
const SECOND_MS: u64 = 1_000;

/// Why a plugin cannot start; no restart follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailReason {
    /// The folder no longer validates.
    Invalid,
    /// `plugin.json` is not the one consent was given on.
    Changed,
    /// Windows refused to run the executable.
    LaunchDenied,
}

/// Where Plisto stands with a plugin, whatever the plugin itself claims.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "host")]
pub enum HostState {
    /// Not running, not serving, or stopped by Plisto.
    Off,
    /// Launched, or a remount asked for; not ready or live yet.
    Starting,
    Running,
    /// Silent past the heartbeat threshold, or reported so by its frame. Never killed for it.
    NotResponding,
    /// Asked to shut down, inside the grace period.
    Stopping,
    /// Crashed; a restart is due.
    Restarting {
        retry_in_ms: u64,
    },
    /// A crashed page frame, waiting for the user's restart.
    Stopped,
    /// Crashed too often and turned off.
    CrashLoop,
    Failed {
        reason: FailReason,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashReason {
    /// The child's output ended or the process exited.
    Exited,
    /// The child sent a broken frame.
    Protocol,
    /// No valid `ready` in time.
    Handshake,
    /// The process could not be started.
    Launch,
    /// A frame that stopped answering.
    Silent,
    /// A frame that left its page.
    Navigated,
    /// A frame that never initialised.
    Init,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CrashInfo {
    pub reason: CrashReason,
    pub exit_code: Option<u32>,
    /// Wall-clock Unix milliseconds.
    pub at_ms: u64,
}

/// What a native child last reported through `status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Reported {
    pub state: ReportedState,
    pub text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PluginStatus {
    pub id: String,
    #[serde(flatten)]
    pub host: HostState,
    /// Native only; None until the first valid status.
    pub reported: Option<Reported>,
    /// This plugin holds Plisto's output now.
    pub takeover: bool,
    /// The last host-side release, cleared on the next grant.
    pub takeover_revoked: Option<TakeoverReason>,
    pub crash: Option<CrashInfo>,
    pub protocol_errors: u32,
    pub rev: u64,
}

/// The status dot a plugin shows in the rail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    None,
    Grey,
    Cyan,
    Amber,
}

impl PluginStatus {
    fn new(id: &str) -> PluginStatus {
        PluginStatus {
            id: id.to_string(),
            host: HostState::Off,
            reported: None,
            takeover: false,
            takeover_revoked: None,
            crash: None,
            protocol_errors: 0,
            rev: 0,
        }
    }

    /// The host state decides first: what the child reports counts only while it is running.
    pub fn tone(&self) -> Tone {
        match self.host {
            HostState::Running if self.takeover => Tone::Cyan,
            HostState::Running => match self.reported.as_ref().map(|r| r.state) {
                None => Tone::None,
                Some(ReportedState::Idle) => Tone::Grey,
                Some(ReportedState::On) => Tone::Cyan,
                Some(ReportedState::Warn) => Tone::Amber,
            },
            HostState::NotResponding
            | HostState::Restarting { .. }
            | HostState::Stopped
            | HostState::Failed { .. } => Tone::Amber,
            HostState::Off | HostState::Starting | HostState::Stopping | HostState::CrashLoop => {
                Tone::None
            }
        }
    }
}

struct Slot {
    status: PluginStatus,
    /// A reported change waiting for its turn.
    pending: Option<Reported>,
    report_gate: ProgressThrottle,
    /// Times of the emits within the last second.
    emitted: VecDeque<u64>,
    /// Changed since the last emit.
    dirty: bool,
}

impl Slot {
    fn new(id: &str) -> Slot {
        Slot {
            status: PluginStatus::new(id),
            pending: None,
            report_gate: ProgressThrottle::new(REPORT_EVERY_MS),
            emitted: VecDeque::new(),
            dirty: false,
        }
    }

    fn changed(&mut self) {
        self.status.rev += 1;
        self.dirty = true;
    }

    fn apply_pending(&mut self, now_ms: u64) {
        if self.pending.is_some() && self.report_gate.should_emit(now_ms, false) {
            self.status.reported = self.pending.take();
            self.changed();
        }
    }

    /// The status to emit now, when it changed and the cap allows.
    fn due(&mut self, now_ms: u64) -> Option<PluginStatus> {
        if !self.dirty {
            return None;
        }
        while self
            .emitted
            .front()
            .is_some_and(|at| now_ms.saturating_sub(*at) >= SECOND_MS)
        {
            self.emitted.pop_front();
        }
        if self.emitted.len() >= EMITS_PER_SEC {
            return None;
        }
        self.emitted.push_back(now_ms);
        self.dirty = false;
        Some(self.status.clone())
    }
}

pub struct StatusBoard {
    slots: Mutex<HashMap<String, Slot>>,
    link: Arc<dyn HostLink>,
    // Throttle times are milliseconds since this instant.
    origin: Instant,
}

impl StatusBoard {
    pub fn new(link: Arc<dyn HostLink>, origin: Instant) -> StatusBoard {
        StatusBoard {
            slots: Mutex::default(),
            link,
            origin,
        }
    }

    fn slots(&self) -> MutexGuard<'_, HashMap<String, Slot>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn ms(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.origin).as_millis() as u64
    }

    /// Changes one plugin's slot and emits it when due. The emit happens after the lock is released.
    fn update(&self, id: &str, now: Instant, change: impl FnOnce(&mut Slot)) {
        let now_ms = self.ms(now);
        let due = {
            let mut slots = self.slots();
            let slot = slots.entry(id.to_string()).or_insert_with(|| Slot::new(id));
            change(slot);
            slot.due(now_ms)
        };
        if let Some(status) = due {
            self.link.emit_status(&status);
        }
    }

    pub fn get(&self, id: &str) -> Option<PluginStatus> {
        self.slots().get(id).map(|slot| slot.status.clone())
    }

    pub fn host(&self, id: &str) -> Option<HostState> {
        self.slots().get(id).map(|slot| slot.status.host)
    }

    /// Every status held, by id.
    pub fn all(&self) -> Vec<PluginStatus> {
        let mut all: Vec<PluginStatus> = self.slots().values().map(|s| s.status.clone()).collect();
        all.sort_by(|a, b| a.id.cmp(&b.id));
        all
    }

    pub fn set_host(&self, id: &str, host: HostState, now: Instant) {
        self.update(id, now, |slot| {
            if slot.status.host != host {
                slot.status.host = host;
                slot.changed();
            }
        });
    }

    /// Records a crash and the host state it leads to, as one change.
    pub fn crashed(&self, id: &str, host: HostState, crash: CrashInfo, now: Instant) {
        self.update(id, now, |slot| {
            slot.status.host = host;
            slot.status.crash = Some(crash);
            slot.changed();
        });
    }

    /// Back to off after a stop, except a crash loop, which shows until the next start.
    pub fn stopped(&self, id: &str, now: Instant) {
        if self.slots().contains_key(id) {
            self.update(id, now, |slot| {
                if !matches!(slot.status.host, HostState::Off | HostState::CrashLoop) {
                    slot.status.host = HostState::Off;
                    slot.changed();
                }
            });
        }
    }

    /// Every plugin off, crash loops included: nothing runs for the rest of the session.
    pub fn all_off(&self, now: Instant) {
        let ids: Vec<String> = self.slots().keys().cloned().collect();
        for id in ids {
            self.set_host(&id, HostState::Off, now);
        }
    }

    /// Forgets the last crash, for a start the user asked for.
    pub fn clear_crash(&self, id: &str, now: Instant) {
        if self.slots().contains_key(id) {
            self.update(id, now, |slot| {
                if slot.status.crash.take().is_some() {
                    slot.changed();
                }
            });
        }
    }

    /// Takes a child's report. Applied at once when the last one is a second old, otherwise held for
    /// the tick; a newer report replaces a held one.
    pub fn report(&self, id: &str, reported: Reported, now: Instant) {
        let now_ms = self.ms(now);
        self.update(id, now, |slot| {
            if slot.status.reported.as_ref() == Some(&reported) {
                slot.pending = None;
                return;
            }
            slot.pending = Some(reported);
            slot.apply_pending(now_ms);
        });
    }

    /// The plugin holds Plisto's output; a previous revocation no longer shows.
    pub fn took_over(&self, id: &str, now: Instant) {
        self.update(id, now, |slot| {
            if !slot.status.takeover || slot.status.takeover_revoked.is_some() {
                slot.status.takeover = true;
                slot.status.takeover_revoked = None;
                slot.changed();
            }
        });
    }

    /// The plugin no longer holds Plisto's output; `revoked` names a host-side release.
    pub fn gave_back(&self, id: &str, revoked: Option<TakeoverReason>, now: Instant) {
        self.update(id, now, |slot| {
            if slot.status.takeover {
                slot.status.takeover = false;
                if revoked.is_some() {
                    slot.status.takeover_revoked = revoked;
                }
                slot.changed();
            }
        });
    }

    pub fn protocol_error(&self, id: &str, now: Instant) {
        self.update(id, now, |slot| {
            slot.status.protocol_errors = slot.status.protocol_errors.saturating_add(1);
            slot.changed();
        });
    }

    /// Applies held reports whose turn came and emits whatever the cap held back.
    pub fn flush(&self, now: Instant) {
        let now_ms = self.ms(now);
        let due: Vec<PluginStatus> = self
            .slots()
            .values_mut()
            .filter_map(|slot| {
                slot.apply_pending(now_ms);
                slot.due(now_ms)
            })
            .collect();
        for status in &due {
            self.link.emit_status(status);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::native::link::RecordingLink;
    use std::time::Duration;

    const ID: &str = "com.example.demo";

    fn board() -> (StatusBoard, Arc<RecordingLink>, Instant) {
        let link = Arc::new(RecordingLink::default());
        let t0 = Instant::now();
        (StatusBoard::new(link.clone(), t0), link, t0)
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn on(text: &str) -> Reported {
        Reported {
            state: ReportedState::On,
            text: Some(text.into()),
        }
    }

    fn warn() -> Reported {
        Reported {
            state: ReportedState::Warn,
            text: None,
        }
    }

    #[test]
    fn a_status_serializes_flat_with_its_host_tag() {
        let mut status = PluginStatus::new(ID);
        status.host = HostState::Restarting { retry_in_ms: 2000 };
        status.crash = Some(CrashInfo {
            reason: CrashReason::Exited,
            exit_code: Some(3),
            at_ms: 7,
        });
        status.reported = Some(on("Mirroring"));
        status.rev = 4;
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "id": ID, "host": "restarting", "retry_in_ms": 2000,
                "reported": { "state": "on", "text": "Mirroring" },
                "takeover": false, "takeover_revoked": null,
                "crash": { "reason": "exited", "exit_code": 3, "at_ms": 7 },
                "protocol_errors": 0, "rev": 4
            })
        );
        status.host = HostState::Failed {
            reason: FailReason::LaunchDenied,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["host"], "failed");
        assert_eq!(json["reason"], "launch_denied");
        status.host = HostState::NotResponding;
        assert_eq!(
            serde_json::to_value(&status).unwrap()["host"],
            "not_responding"
        );
        status.host = HostState::CrashLoop;
        assert_eq!(serde_json::to_value(&status).unwrap()["host"], "crash_loop");
    }

    #[test]
    fn a_host_state_wins_over_what_the_child_claims() {
        let (board, _, t0) = board();
        board.set_host(ID, HostState::Running, t0);
        board.report(ID, on("Mirroring"), t0);
        assert_eq!(board.get(ID).unwrap().tone(), Tone::Cyan);
        board.set_host(ID, HostState::NotResponding, t0 + ms(10));
        assert_eq!(board.get(ID).unwrap().tone(), Tone::Amber);
        // The child claims to be on again while it does not answer pings: still amber.
        board.report(ID, warn(), t0 + ms(2000));
        board.report(ID, on("Mirroring again"), t0 + ms(4000));
        let status = board.get(ID).unwrap();
        assert_eq!(status.reported, Some(on("Mirroring again")));
        assert_eq!(status.tone(), Tone::Amber);
        board.set_host(ID, HostState::Running, t0 + ms(5000));
        assert_eq!(board.get(ID).unwrap().tone(), Tone::Cyan);
    }

    #[test]
    fn a_report_applies_at_most_once_a_second_and_the_last_one_is_flushed() {
        let (board, link, t0) = board();
        board.set_host(ID, HostState::Running, t0);
        board.report(ID, on("a"), t0);
        board.report(ID, warn(), t0 + ms(100));
        board.report(ID, on("b"), t0 + ms(200));
        assert_eq!(board.get(ID).unwrap().reported, Some(on("a")));
        board.flush(t0 + ms(999));
        assert_eq!(board.get(ID).unwrap().reported, Some(on("a")));
        board.flush(t0 + ms(1000));
        assert_eq!(board.get(ID).unwrap().reported, Some(on("b")));
        let reported: Vec<Option<Reported>> =
            link.statuses().into_iter().map(|s| s.reported).collect();
        assert_eq!(reported, [None, Some(on("a")), Some(on("b"))]);
        // A report equal to the applied one changes nothing.
        board.report(ID, on("b"), t0 + ms(3000));
        assert_eq!(link.statuses().len(), 3);
    }

    #[test]
    fn a_flip_back_inside_the_second_cancels_the_held_report() {
        let (board, link, t0) = board();
        board.report(ID, on("a"), t0);
        board.report(ID, warn(), t0 + ms(100));
        board.report(ID, on("a"), t0 + ms(200));
        board.flush(t0 + ms(2000));
        assert_eq!(link.statuses().len(), 1);
    }

    #[test]
    fn emits_are_capped_per_second_and_rev_only_grows() {
        let (board, link, t0) = board();
        for n in 0..10 {
            board.protocol_error(ID, t0 + ms(n));
        }
        assert_eq!(link.statuses().len(), EMITS_PER_SEC);
        assert_eq!(board.get(ID).unwrap().protocol_errors, 10);
        board.flush(t0 + ms(500));
        assert_eq!(link.statuses().len(), EMITS_PER_SEC);
        board.flush(t0 + ms(1000));
        let sent = link.statuses();
        assert_eq!(sent.len(), EMITS_PER_SEC + 1);
        assert_eq!(sent.last().unwrap().protocol_errors, 10);
        assert!(sent.windows(2).all(|w| w[0].rev < w[1].rev));
        // Nothing changed since: nothing more goes out.
        board.flush(t0 + ms(5000));
        assert_eq!(link.statuses().len(), EMITS_PER_SEC + 1);
    }

    #[test]
    fn a_stop_leaves_a_crash_loop_showing() {
        let (board, _, t0) = board();
        board.set_host(ID, HostState::CrashLoop, t0);
        board.stopped(ID, t0);
        assert_eq!(board.host(ID), Some(HostState::CrashLoop));
        board.set_host(ID, HostState::Restarting { retry_in_ms: 1 }, t0);
        board.stopped(ID, t0);
        assert_eq!(board.host(ID), Some(HostState::Off));
        // An id never seen gets no entry.
        board.stopped("com.example.other", t0);
        assert!(board.get("com.example.other").is_none());
    }
}
