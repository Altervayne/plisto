/*
 * Process tests for output takeover: who may hold Plisto's output, and that every way a hold ends
 * restores the output before anything else changes. Every child is the test binary in one of the
 * behaviors of `test_child.rs`. Most tests ask for the output on the child's behalf, through the entry
 * its `takeover` frame reaches, and record each engine command with the plugin's whole status as it
 * stood when the command went out, so a restore that follows any status change shows.
 */

// -- Library Imports --
use std::fs;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

// -- Local Imports --
use super::child::SendError;
use super::protocol::{HostMessage, TakeoverReason};
use super::status::{HostState, PluginStatus, StatusBoard};
use super::takeover::PlayerLink;
use super::test_child::RESUME_FILE;
use super::tests::{eventually, Supervised};
use super::Run;
use crate::audio::PlayerCmd;
use crate::plugins::lifecycle;
use crate::plugins::paths::data_dir;
use crate::plugins::state::{BootView, Runtime};
use crate::plugins::test_kit::{native, ID};

const TAKEOVER: &str = "audio.output_takeover";
const OTHER: &str = "com.example.other";

/// Records every takeover command with the plugin's status at the moment it went out.
#[derive(Default)]
struct Journal {
    board: OnceLock<Arc<StatusBoard>>,
    seen: Mutex<Vec<(bool, Option<PluginStatus>)>>,
}

impl PlayerLink for Journal {
    fn player(&self, cmd: PlayerCmd) {
        if let PlayerCmd::SetOutputTakeover(on) = cmd {
            let status = self.board.get().and_then(|board| board.get(ID));
            self.seen.lock().unwrap().push((on, status));
        }
    }
}

impl Journal {
    fn commands(&self) -> Vec<bool> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(on, _)| *on)
            .collect()
    }

    /// The status the plugin had when the last restore went out.
    fn at_last_restore(&self) -> Option<PluginStatus> {
        let seen = self.seen.lock().unwrap();
        seen.iter()
            .rev()
            .find(|(on, _)| !on)
            .and_then(|(_, status)| status.clone())
    }
}

/// A supervised plugin whose takeover commands go to a journal.
fn journaled(mode: &str, caps: &[&str]) -> (Supervised, Arc<Journal>) {
    let journal = Arc::new(Journal::default());
    let player = journal.clone();
    let s = Supervised::hosted(mode, caps, |host| host.with_takeover_player(player));
    let _ = journal.board.set(s.host.board.clone());
    (s, journal)
}

/// A running plugin granted the capability, holding the output.
fn holding(mode: &str) -> (Supervised, Arc<Journal>) {
    let (s, journal) = journaled(mode, &[TAKEOVER]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert_eq!(s.take(true), TakeoverReason::Granted);
    assert_eq!(journal.commands(), [true]);
    (s, journal)
}

impl Supervised {
    fn current_run(&self) -> Arc<Run> {
        self.host.children.lock().unwrap().get(ID).unwrap().clone()
    }

    fn now(&self) -> PluginStatus {
        self.host.status(ID).unwrap()
    }

    /// The current run's child asking for the output, or giving it back.
    fn take(&self, hold: bool) -> TakeoverReason {
        self.host.takeover(ID, &self.current_run(), hold)
    }

    /// Every `takeover_state` the child heard, as `(held, reason)`, in order.
    fn takeover_states(&self) -> Vec<(bool, String)> {
        self.stderr()
            .lines()
            .filter_map(|line| line.strip_prefix("takeover_state="))
            .filter_map(|json| serde_json::from_str::<Value>(json).ok())
            .map(|m| {
                let held = m["held"].as_bool().unwrap_or(false);
                (held, m["reason"].as_str().unwrap_or("").to_string())
            })
            .collect()
    }

    /// Waits until the child heard `(held, reason)` `count` times.
    fn heard(&self, held: bool, reason: &str, count: usize) -> bool {
        let times = || {
            let states = self.takeover_states();
            states
                .iter()
                .filter(|(h, r)| *h == held && r == reason)
                .count()
        };
        eventually(|| times() >= count) && times() == count
    }

    fn resume(&self) {
        fs::write(data_dir(&self.k.data, ID).join(RESUME_FILE), b"").unwrap();
    }
}

/// The hold ended for `why`: one restore, sent while the status was still `before` in every field,
/// and the status shows the release now.
fn assert_released(
    s: &Supervised,
    journal: &Journal,
    before: &PluginStatus,
    why: Option<TakeoverReason>,
) {
    assert_eq!(journal.commands(), [true, false]);
    assert_eq!(journal.at_last_restore().as_ref(), Some(before));
    let status = s.now();
    assert!(!status.takeover);
    assert_eq!(status.takeover_revoked, why);
    assert_eq!(s.host.takeover.holder(), None);
}

#[test]
fn a_hold_needs_the_capability_and_a_running_plugin() {
    let (s, journal) = journaled("echo", &[]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert_eq!(s.take(true), TakeoverReason::Denied);
    assert!(s.heard(false, "denied", 1), "{}", s.stderr());
    assert!(journal.commands().is_empty());
    assert!(!s.now().takeover);

    // Granted, but not responding.
    let (s, journal) = journaled("stall-until-file", &[TAKEOVER]);
    s.start();
    assert!(s.reaches(HostState::Running));
    for _ in 0..3 {
        s.tick_after(Duration::from_secs(1));
    }
    assert_eq!(s.state(), Some(HostState::NotResponding));
    assert_eq!(s.take(true), TakeoverReason::Denied);
    assert!(journal.commands().is_empty());
    s.resume();
}

#[test]
fn a_second_plugin_asking_while_one_holds_is_busy_and_the_holder_is_untouched() {
    let (s, journal) = journaled("echo", &[TAKEOVER]);
    s.start();
    assert!(s.reaches(HostState::Running));
    s.host.hold_output_for(OTHER);
    assert_eq!(s.take(true), TakeoverReason::Busy);
    assert!(s.heard(false, "busy", 1), "{}", s.stderr());
    assert_eq!(s.host.takeover.holder().as_deref(), Some(OTHER));
    assert_eq!(journal.commands(), [true]);
    assert!(s.host.status(OTHER).unwrap().takeover);
    assert!(!s.now().takeover);
}

#[test]
fn a_grant_is_answered_and_asking_again_sends_no_second_command() {
    let (s, journal) = holding("echo");
    assert!(s.heard(true, "granted", 1), "{}", s.stderr());
    let status = s.now();
    assert!(status.takeover);
    assert_eq!(status.takeover_revoked, None);
    assert_eq!(s.take(true), TakeoverReason::Granted);
    assert_eq!(journal.commands(), [true]);
}

#[test]
fn the_child_giving_the_output_back_restores_it_first() {
    let (s, journal) = holding("echo");
    let before = s.now();
    assert_eq!(s.take(false), TakeoverReason::Released);
    assert_released(&s, &journal, &before, None);
    assert!(s.heard(false, "released", 1), "{}", s.stderr());
}

#[test]
fn a_holder_that_may_no_longer_hold_is_told_the_truth_and_loses_the_output() {
    let (s, journal) = holding("echo");
    // An update or a disable takes the plugin out of the serving set before its stop.
    let withdrawn = s.plugins.withdraw(ID);
    let before = s.now();
    assert_eq!(s.take(true), TakeoverReason::Denied);
    assert_released(&s, &journal, &before, Some(TakeoverReason::Denied));
    assert!(s.heard(false, "denied", 1), "{}", s.stderr());
    drop(withdrawn);
}

#[test]
fn a_user_release_restores_first_and_the_next_grant_clears_it() {
    let (s, journal) = holding("echo");
    let before = s.now();
    assert!(s.host.release_takeover(TakeoverReason::User));
    assert_released(&s, &journal, &before, Some(TakeoverReason::User));
    assert!(s.heard(false, "user", 1), "{}", s.stderr());
    // Nothing is held any more.
    assert!(!s.host.release_takeover(TakeoverReason::User));
    assert_eq!(journal.commands(), [true, false]);

    assert_eq!(s.take(true), TakeoverReason::Granted);
    let status = s.now();
    assert!(status.takeover);
    assert_eq!(status.takeover_revoked, None);
}

#[test]
fn a_crash_restores_the_output_first() {
    let (s, journal) = holding("echo");
    let before = s.now();
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert_released(&s, &journal, &before, Some(TakeoverReason::Stopped));
}

#[test]
fn an_ending_run_is_granted_nothing() {
    let (s, journal) = journaled("echo", &[TAKEOVER]);
    s.start();
    assert!(s.reaches(HostState::Running));
    let run = s.current_run();
    // The state a crash puts the run in for the time its process tree takes to die.
    run.ending.store(true, Ordering::SeqCst);
    assert_eq!(s.take(true), TakeoverReason::Denied);
    assert!(s.heard(false, "denied", 1), "{}", s.stderr());
    assert!(journal.commands().is_empty());
    assert!(!s.now().takeover);

    // A crash marks its run ending before it does anything else.
    let (s, _) = holding("echo");
    let run = s.current_run();
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert!(run.ending.load(Ordering::SeqCst));
}

#[test]
fn a_user_release_racing_a_crash_restores_once() {
    let (s, journal) = holding("echo");
    let child = s.host.ready_run(ID).unwrap().1;
    let killer = thread::spawn(move || child.kill());
    let released = s.host.release_takeover(TakeoverReason::User);
    killer.join().unwrap();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert_eq!(journal.commands(), [true, false]);
    assert!(journal.at_last_restore().unwrap().takeover);
    let status = s.now();
    assert!(!status.takeover);
    let want = if released {
        TakeoverReason::User
    } else {
        TakeoverReason::Stopped
    };
    assert_eq!(status.takeover_revoked, Some(want));
    assert_eq!(s.host.takeover.holder(), None);
}

#[test]
fn a_crash_loop_while_holding_restores_every_time_and_turns_the_plugin_off() {
    let (s, journal) = holding("echo");
    for (crash, delay) in [(1, 1000), (2, 2000)] {
        let before = s.now();
        s.host.ready_run(ID).unwrap().1.kill();
        assert!(s.reaches(HostState::Restarting { retry_in_ms: delay }));
        assert_eq!(journal.at_last_restore().as_ref(), Some(&before), "{crash}");
        s.tick_after(Duration::from_millis(delay));
        assert!(s.reaches(HostState::Running));
        assert_eq!(s.take(true), TakeoverReason::Granted);
    }
    let before = s.now();
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::CrashLoop));
    assert!(eventually(|| !s.plugins.is_enabled(ID)));
    assert_eq!(journal.commands(), [true, false, true, false, true, false]);
    assert_eq!(journal.at_last_restore().as_ref(), Some(&before));
    let status = s.now();
    assert!(!status.takeover);
    assert_eq!(status.takeover_revoked, Some(TakeoverReason::Stopped));
    assert_eq!(s.host.takeover.holder(), None);
}

#[test]
fn every_stop_restores_the_output_first() {
    type End = fn(&Supervised);
    let ends: [(&str, End); 7] = [
        ("stop", |s| s.host.stop_plugin(ID)),
        ("restart", |s| s.host.restart(&s.plugins, ID).unwrap()),
        ("disable", |s| {
            lifecycle::disable(&s.k.data, &s.plugins, ID).unwrap();
        }),
        ("uninstall", |s| {
            lifecycle::uninstall(&s.k.data, &s.plugins, ID, false).unwrap();
        }),
        ("update", |s| {
            let token = s.k.inspect_into(&s.plugins, &native("1.1.0", &[TAKEOVER]));
            crate::plugins::update::update(&s.k.data, &s.plugins, &token).unwrap();
        }),
        ("safe mode", |s| {
            s.host.on_runtime_safe(BootView {
                runtime: Runtime::Safe,
                unclean: false,
                safe_flag: false,
            })
        }),
        ("exit", |s| {
            s.host.begin_exit();
            assert!(s.host.release_takeover(TakeoverReason::Stopped));
            s.host.shutdown_all();
        }),
    ];
    for (name, end) in ends {
        let (s, journal) = holding("echo");
        let before = s.now();
        end(&s);
        assert_eq!(journal.commands(), [true, false], "{name}");
        assert_eq!(journal.at_last_restore().as_ref(), Some(&before), "{name}");
        let status = s.now();
        assert!(!status.takeover, "{name}");
        assert_eq!(
            status.takeover_revoked,
            Some(TakeoverReason::Stopped),
            "{name}"
        );
        assert_eq!(s.host.takeover.holder(), None, "{name}");
        // A stopped child is still running when it is told; a restarted one's log starts afresh.
        if name == "stop" || name == "disable" {
            assert!(s.heard(false, "stopped", 1), "{name}: {}", s.stderr());
        }
    }
}

#[test]
fn a_silence_restores_once_and_a_recovered_child_stays_unmuted_until_it_asks_again() {
    let (s, journal) = holding("stall-until-file");
    for _ in 0..2 {
        s.tick_after(Duration::from_secs(1));
    }
    let before = s.now();
    s.tick_after(Duration::from_secs(1));
    assert_eq!(s.state(), Some(HostState::NotResponding));
    assert_released(&s, &journal, &before, Some(TakeoverReason::NotResponding));
    assert!(s.heard(false, "not_responding", 1), "{}", s.stderr());
    // Still silent: nothing more is sent.
    for _ in 0..3 {
        s.tick_after(Duration::from_secs(1));
    }
    assert_eq!(journal.commands(), [true, false]);

    // Answering again, the child is told its state once more and gets nothing back.
    s.resume();
    assert!(eventually(|| {
        s.tick_after(Duration::from_secs(1));
        s.state() == Some(HostState::Running)
    }));
    assert!(s.heard(false, "not_responding", 2), "{}", s.stderr());
    assert_eq!(journal.commands(), [true, false]);
    let status = s.now();
    assert!(!status.takeover);
    assert_eq!(status.takeover_revoked, Some(TakeoverReason::NotResponding));

    assert_eq!(s.take(true), TakeoverReason::Granted);
    assert_eq!(journal.commands(), [true, false, true]);
    assert_eq!(s.now().takeover_revoked, None);
}

#[test]
fn a_stale_runs_takeover_is_refused() {
    let (s, journal) = journaled("echo", &[TAKEOVER]);
    s.start();
    assert!(s.reaches(HostState::Running));
    let old = s.current_run();
    s.host.restart(&s.plugins, ID).unwrap();
    assert!(s.reaches(HostState::Running));
    assert_eq!(s.host.takeover(ID, &old, true), TakeoverReason::Denied);
    assert!(journal.commands().is_empty());

    // Nor can it give back what the current run holds.
    assert_eq!(s.take(true), TakeoverReason::Granted);
    assert_eq!(s.host.takeover(ID, &old, false), TakeoverReason::Released);
    assert_eq!(s.host.takeover.holder().as_deref(), Some(ID));
    assert!(s.now().takeover);
    assert_eq!(journal.commands(), [true]);
}

#[test]
fn a_state_the_outbox_had_no_room_for_goes_out_after_the_next_pong() {
    let (s, journal) = journaled("read-after-file", &[TAKEOVER]);
    s.start();
    assert!(s.reaches(HostState::Running));
    let (run, child) = s.host.ready_run(ID).unwrap();
    let big = HostMessage::Feed {
        event: json!("y".repeat(64 * 1024)),
        lost: 0,
    };
    let mut full = false;
    for _ in 0..10_000 {
        if child.send(&big) == Err(SendError::Full) {
            full = true;
            break;
        }
    }
    assert!(full);
    assert_eq!(s.take(true), TakeoverReason::Granted);
    assert_eq!(journal.commands(), [true]);
    assert_eq!(run.stats.takeover_dropped.load(Ordering::Relaxed), 1);

    // Once the child reads again the outbox has room, so the next ping goes out; its pong brings
    // the owed state.
    s.resume();
    assert!(eventually(|| child
        .send(&HostMessage::Page { open: false })
        .is_ok()));
    s.tick_after(Duration::from_secs(1));
    assert!(s.heard(true, "granted", 1), "{}", s.stderr());
    assert!(run.takeover_owed.lock().unwrap().is_none());
    assert_eq!(s.state(), Some(HostState::Running));
}

#[test]
fn a_child_that_takes_the_output_and_crashes_gets_it_restored() {
    let s = Supervised::granted("takeover", &[TAKEOVER]);
    s.start();
    assert!(eventually(|| s
        .host
        .status(ID)
        .is_some_and(|status| status.takeover)));
    assert_eq!(s.link.takeovers(), [true]);
    assert!(s.heard(true, "granted", 1), "{}", s.stderr());

    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert_eq!(s.link.takeovers(), [true, false]);
    let status = s.now();
    assert!(!status.takeover);
    assert_eq!(status.takeover_revoked, Some(TakeoverReason::Stopped));
}
