/*
 * The background library sync: one resident thread that keeps the index current without the user
 * asking. Roots on local fixed drives are watched and their changes gathered into a dirty set; other
 * roots are polled when the window regains focus. Settled work runs as narrowed passes of the regular
 * scan, one at a time and spaced apart, inside a two-thread pool so playback never starves. A pass
 * takes the scan lock as a background holder, so any user scan preempts it and it simply retries.
 * A reachability probe tracks roots going offline and coming back, and files still being copied are
 * retried later with backoff. The thread owns all of its state; commands reach it through SyncCmd.
 */

// -- Module Declarations --
mod classify;
mod delta;
mod dirty;
mod session;
mod watch;

// -- Library Imports --
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use tauri::{AppHandle, Emitter, Manager};

// -- Local Imports --
use crate::db;
use crate::dto::{RootWatchMode, RootWatchState, ScanSummary};
use crate::normalize::normalize_path_key;
use crate::scan::{self, ScanRoot, ScanUnit, UnitKey};
use crate::scan_lock::{acquire_scan_lock, Holder, ScanLockGuard};
use crate::state::AppState;
use classify::{classify, FsHit};
use dirty::{DirtySet, RootWork};
use session::Session;
use watch::Watches;

/// How often the thread wakes with nothing to do, to run its timers.
const TICK: Duration = Duration::from_millis(250);

/// The least time between the end of one pass and the start of the next.
const PASS_GAP: Duration = Duration::from_secs(5);

/// How often every root is checked for reachability.
const PROBE_EVERY: Duration = Duration::from_secs(30);

/// How long after launch the startup pass runs, so it never competes with the first render.
const STARTUP_DELAY: Duration = Duration::from_secs(5);

/// The least time between two focus passes of the same polled root.
const POLL_GAP: Duration = Duration::from_secs(120);

/// Retry spacing for a deferred file's folder: doubles from the first value up to the second.
const DEFER_BACKOFF_FIRST: Duration = Duration::from_secs(5);
const DEFER_BACKOFF_MAX: Duration = Duration::from_secs(60);

/// A request to the sync thread.
pub enum SyncCmd {
    /// A raw watcher event.
    Fs(notify::Result<notify::Event>),
    /// Roots were added or removed; re-read them from the index.
    RootsChanged,
    /// The main window regained focus.
    Focus,
    /// A manual rescan of one root, or of every root when None.
    Request(Option<i64>),
    /// The keep-up-to-date setting changed.
    SetEnabled(bool),
    Shutdown,
}

/// Starts the sync thread. `tx` is a sender onto the thread's own channel, handed to the watcher.
pub fn spawn(app: AppHandle, rx: Receiver<SyncCmd>, tx: Sender<SyncCmd>) {
    let _ = std::thread::Builder::new()
        .name("library-sync".to_string())
        .spawn(move || Coordinator::new(app, tx).run(&rx));
}

/// One library root as the sync thread tracks it.
struct RootEntry {
    id: i64,
    path: PathBuf,
    online: bool,
    watched: bool,
    last_poll: Option<Instant>,
}

impl RootEntry {
    fn mode(&self) -> RootWatchMode {
        if !self.online {
            RootWatchMode::Offline
        } else if self.watched {
            RootWatchMode::Watching
        } else {
            RootWatchMode::Polling
        }
    }
}

/// A file a pass deferred, waiting for its folder to be retried.
struct Deferral {
    root: i64,
    parent: PathBuf,
    /// When it was first deferred, in unix seconds: the scan reads it anyway past its limit.
    since: i64,
    attempts: u32,
    /// When its folder goes back into the dirty set; None once it has.
    due: Option<Instant>,
}

/// Whether the gap after the last pass lets the next one start. A manual request skips the gap, so a
/// click right after another pass still starts at once; every other trigger waits it out.
fn gap_allows(last_pass_end: Option<Instant>, now: Instant, requested: bool) -> bool {
    requested || last_pass_end.is_none_or(|t| now.saturating_duration_since(t) >= PASS_GAP)
}

struct Coordinator {
    app: AppHandle,
    dirty: DirtySet,
    roots: Vec<RootEntry>,
    watches: Watches,
    enabled: bool,
    startup_due: Option<Instant>,
    last_pass_end: Option<Instant>,
    /// A manual rescan is waiting: the next pass skips the gap after the previous one.
    requested: bool,
    next_probe: Instant,
    session: Option<Session>,
    /// Deferred files by canonical key.
    deferred: HashMap<String, Deferral>,
    pool: Option<rayon::ThreadPool>,
    published: Vec<RootWatchState>,
}

impl Coordinator {
    fn new(app: AppHandle, tx: Sender<SyncCmd>) -> Self {
        let now = Instant::now();
        let enabled = app
            .state::<AppState>()
            .keep_library_up_to_date
            .load(Ordering::Relaxed);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .thread_name(|i| format!("library-sync-{i}"))
            .build()
            .ok();
        let mut sync = Self {
            app,
            dirty: DirtySet::default(),
            roots: Vec::new(),
            watches: Watches::new(tx),
            enabled,
            startup_due: enabled.then(|| now + STARTUP_DELAY),
            last_pass_end: None,
            requested: false,
            next_probe: now + PROBE_EVERY,
            session: None,
            deferred: HashMap::new(),
            pool,
            published: Vec::new(),
        };
        sync.sync_roots();
        sync
    }

    fn run(mut self, rx: &Receiver<SyncCmd>) {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(SyncCmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(cmd) => self.handle(cmd, Instant::now()),
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.tick(Instant::now());
        }
    }

    fn handle(&mut self, cmd: SyncCmd, now: Instant) {
        match cmd {
            SyncCmd::Fs(Ok(event)) => {
                if !self.enabled {
                    return;
                }
                let probe = |p: &Path| std::fs::metadata(p).ok().map(|m| m.is_dir());
                for hit in classify(&event, probe) {
                    match hit {
                        FsHit::Changed(path, kind) => self.dirty.note(&path, kind, now),
                        FsHit::Overflow(path) => self.dirty.overflow(path.as_deref(), now),
                    }
                }
            }
            SyncCmd::Fs(Err(err)) => self.watch_failed(&err.paths, now),
            SyncCmd::RootsChanged => self.sync_roots(),
            SyncCmd::Focus => self.poll_on_focus(now),
            SyncCmd::Request(Some(id)) => {
                self.dirty.escalate(id, None);
                self.requested = true;
            }
            SyncCmd::Request(None) => {
                for root in &self.roots {
                    self.dirty.escalate(root.id, None);
                }
                self.requested = true;
            }
            SyncCmd::SetEnabled(on) => self.set_enabled(on),
            SyncCmd::Shutdown => {}
        }
    }

    fn tick(&mut self, now: Instant) {
        if now >= self.next_probe {
            self.next_probe = now + PROBE_EVERY;
            self.probe_roots();
        }
        if self.startup_due.is_some_and(|due| now >= due) {
            self.startup_due = None;
            for root in &self.roots {
                self.dirty.escalate(root.id, None);
            }
        }
        for d in self.deferred.values_mut() {
            if d.due.is_some_and(|due| now >= due) {
                d.due = None;
                let unit = ScanUnit {
                    dir: d.parent.clone(),
                    recursive: false,
                };
                self.dirty.requeue(d.root, Some(vec![unit]));
            }
        }
        if let Some(session) = &self.session {
            session.flush_delta(&self.app, false);
        }
        self.maybe_pass(now);
        if self.session.is_some() && self.dirty.is_empty() {
            self.end_session();
        }
    }

    // ---- Passes ----

    /// Runs one pass when work has settled, the gap since the last pass allows it, and the scan
    /// lock is free. A busy lock is left for the next tick. The run loop ticks right after every
    /// command, so a manual request starts here without waiting for the timer.
    fn maybe_pass(&mut self, now: Instant) {
        if self.dirty.is_empty() || !gap_allows(self.last_pass_end, now, self.requested) {
            return;
        }
        let work = self.dirty.take_settled(now);
        if work.is_empty() {
            return;
        }
        let app = self.app.clone();
        let state = app.state::<AppState>();
        let Ok(guard) = acquire_scan_lock(&state, Holder::Background) else {
            for (id, units) in work {
                self.dirty.requeue(id, units);
            }
            return;
        };
        self.requested = false;
        self.run_pass(&state, guard, work);
    }

    fn run_pass(&mut self, state: &AppState, guard: ScanLockGuard<'_>, work: Vec<RootWork>) {
        // Only this pass can be running, so both flags are free to reset: a stale user cancel from an
        // earlier user scan must not read as a cancel of this one.
        state.cancel.store(false, Ordering::SeqCst);
        state.bg_cancel.store(false, Ordering::SeqCst);

        let roots: Vec<ScanRoot> = work
            .iter()
            .filter_map(|(id, units)| {
                self.roots.iter().find(|r| r.id == *id).map(|r| ScanRoot {
                    id: *id,
                    path: r.path.clone(),
                    units: units.clone(),
                })
            })
            .collect();
        if roots.is_empty() {
            return;
        }
        if self.session.is_none() {
            self.session = Some(Session::new(Instant::now()));
        }

        let scanned_at = crate::commands::now_unix();
        let deferred_since: HashMap<String, i64> = self
            .deferred
            .iter()
            .map(|(key, d)| (key.clone(), d.since))
            .collect();
        let result = {
            let Some(session) = self.session.as_ref() else {
                return;
            };
            let app = &self.app;
            let run = || {
                scan::run_scan(
                    &roots,
                    &state.db_path,
                    &state.bg_cancel,
                    scanned_at,
                    &deferred_since,
                    |e| session.on_emit(app, state, e),
                )
            };
            match self.pool.as_ref() {
                Some(pool) => pool.install(run),
                None => run(),
            }
        };
        drop(guard);
        self.last_pass_end = Some(Instant::now());

        // A database failure drops the work rather than retrying it on every pass.
        let Ok(summary) = result else {
            return;
        };
        if let Some(session) = self.session.as_mut() {
            session.absorb(&summary);
        }
        if summary.cancelled {
            // A user cancel stops the whole session; a preemption or quit puts the work back.
            if state.cancel.load(Ordering::SeqCst) {
                self.dirty.clear();
            } else {
                for (id, units) in work {
                    self.dirty.requeue(id, units);
                }
            }
        } else {
            self.track_deferrals(&summary, &work, scanned_at);
        }
        for id in &summary.offline_roots {
            self.set_online(*id, false);
        }
        self.publish_roots();
    }

    /// Records the files a finished pass deferred and schedules their folders, and forgets the ones
    /// the pass walked and read this time.
    fn track_deferrals(&mut self, summary: &ScanSummary, work: &[RootWork], scanned_at: i64) {
        let now = Instant::now();
        let keys: HashSet<String> = summary
            .deferred_paths
            .iter()
            .map(|p| normalize_path_key(&p.to_string_lossy()))
            .collect();
        self.deferred.retain(|key, d| {
            let walked = work.iter().any(|(id, units)| {
                *id == d.root
                    && units
                        .as_ref()
                        .is_none_or(|units| units.iter().any(|u| UnitKey::of(u).covers(key)))
            });
            keys.contains(key) || !walked
        });
        for path in &summary.deferred_paths {
            let (Some(root), Some(parent)) = (self.dirty.root_for(path), path.parent()) else {
                continue;
            };
            let d = self
                .deferred
                .entry(normalize_path_key(&path.to_string_lossy()))
                .or_insert(Deferral {
                    root,
                    parent: parent.to_path_buf(),
                    since: scanned_at,
                    attempts: 0,
                    due: None,
                });
            d.attempts += 1;
            let backoff = DEFER_BACKOFF_FIRST
                .saturating_mul(1 << d.attempts.saturating_sub(1).min(8))
                .min(DEFER_BACKOFF_MAX);
            d.due = Some(now + backoff);
        }
    }

    fn end_session(&mut self) {
        if let Some(session) = self.session.take() {
            let state = self.app.state::<AppState>();
            session.finish(&self.app, &state);
        }
    }

    // ---- Roots and watches ----

    /// Re-reads the roots from the index: a removed root loses its watch and pending work, a new one
    /// is probed and armed.
    fn sync_roots(&mut self) {
        let targets = {
            let state = self.app.state::<AppState>();
            let Ok(conn) = state.db.lock() else {
                return;
            };
            db::root_targets(&conn).unwrap_or_default()
        };
        let targets: Vec<(i64, PathBuf)> = targets
            .into_iter()
            .map(|(id, path)| (id, PathBuf::from(path)))
            .collect();

        let mut kept = Vec::new();
        for root in std::mem::take(&mut self.roots) {
            if targets.iter().any(|(id, _)| *id == root.id) {
                kept.push(root);
            } else if root.watched {
                self.watches.disarm(&root.path);
            }
        }
        self.roots = kept;
        for (id, path) in &targets {
            if self.roots.iter().any(|r| r.id == *id) {
                continue;
            }
            let online = scan::root_reachable(path);
            let watched = self.enabled && online && self.watches.arm(path);
            self.roots.push(RootEntry {
                id: *id,
                path: path.clone(),
                online,
                watched,
                last_poll: None,
            });
        }
        self.roots.sort_by_key(|r| r.id);
        self.dirty.set_roots(&targets);
        self.deferred
            .retain(|_, d| targets.iter().any(|(id, _)| *id == d.root));
        self.publish_roots();
    }

    /// Checks every root's reachability. A root back online is re-armed and walked whole; one gone
    /// offline loses its watch.
    fn probe_roots(&mut self) {
        let ids: Vec<(i64, bool)> = self
            .roots
            .iter()
            .map(|r| (r.id, scan::root_reachable(&r.path)))
            .collect();
        for (id, up) in ids {
            self.set_online(id, up);
        }
        self.publish_roots();
    }

    fn set_online(&mut self, id: i64, up: bool) {
        let Some(root) = self.roots.iter_mut().find(|r| r.id == id) else {
            return;
        };
        if up == root.online {
            return;
        }
        root.online = up;
        if up {
            if self.enabled {
                root.watched = self.watches.arm(&root.path);
                self.dirty.escalate(id, None);
            }
        } else if root.watched {
            root.watched = false;
            self.watches.disarm(&root.path);
        }
    }

    /// A watch error loses events: the affected roots are walked whole and drop to polling. An error
    /// naming no path affects every watched root.
    fn watch_failed(&mut self, paths: &[PathBuf], now: Instant) {
        let hit: Vec<i64> = paths
            .iter()
            .filter_map(|p| self.dirty.root_for(p))
            .collect();
        for root in self.roots.iter_mut().filter(|r| r.watched) {
            if hit.is_empty() || hit.contains(&root.id) {
                root.watched = false;
                self.watches.disarm(&root.path);
                if self.enabled {
                    self.dirty.escalate(root.id, Some(now));
                }
            }
        }
        self.publish_roots();
    }

    /// Queues a full pass of each polled root not walked on focus recently.
    fn poll_on_focus(&mut self, now: Instant) {
        if !self.enabled {
            return;
        }
        for root in self.roots.iter_mut() {
            let due = root.last_poll.is_none_or(|t| now - t >= POLL_GAP);
            if root.online && !root.watched && due {
                root.last_poll = Some(now);
                self.dirty.escalate(root.id, None);
            }
        }
    }

    fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        if on {
            for root in self.roots.iter_mut() {
                if root.online && !root.watched {
                    root.watched = self.watches.arm(&root.path);
                }
                self.dirty.escalate(root.id, None);
            }
        } else {
            for root in self.roots.iter_mut().filter(|r| r.watched) {
                root.watched = false;
                self.watches.disarm(&root.path);
            }
            self.startup_due = None;
            self.dirty.clear();
            self.deferred.clear();
        }
        self.publish_roots();
    }

    /// Emits `library:roots-state` and refreshes the status snapshot when any root's mode changed.
    fn publish_roots(&mut self) {
        let states: Vec<RootWatchState> = self
            .roots
            .iter()
            .map(|r| RootWatchState {
                id: r.id,
                mode: r.mode(),
            })
            .collect();
        if states == self.published {
            return;
        }
        let _ = self.app.emit("library:roots-state", &states);
        if let Ok(mut status) = self.app.state::<AppState>().library_sync_status.lock() {
            status.roots = states.clone();
        }
        self.published = states;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_pass_needs_no_gap() {
        assert!(gap_allows(None, Instant::now(), false));
    }

    #[test]
    fn a_background_pass_waits_out_the_gap() {
        let end = Instant::now();
        assert!(!gap_allows(Some(end), end + Duration::from_secs(1), false));
        assert!(gap_allows(Some(end), end + PASS_GAP, false));
    }

    #[test]
    fn a_manual_request_skips_the_gap() {
        let end = Instant::now();
        assert!(gap_allows(Some(end), end + Duration::from_millis(10), true));
    }
}
