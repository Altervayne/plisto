/*
 * One background session: the run of passes from the first until the dirty set drains. It keeps the
 * running totals the frontend sees as one scan, forwards progress as throttled `library:sync` ticks,
 * gathers changed ids into `library:delta` flushes, and closes with a single `library:summary`. The
 * progress and writer threads of a pass call into it concurrently, so the mutable parts sit behind
 * Mutexes; the totals only move between passes.
 */

// -- Library Imports --
use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Emitter};

// -- Local Imports --
use super::delta::DeltaBuffer;
use crate::dto::{LibrarySyncSummary, LibrarySyncTick, ScanSummary};
use crate::scan::progress::ProgressThrottle;
use crate::scan::ScanEmit;
use crate::state::AppState;

/// The shortest gap between two `library:sync` ticks.
const TICK_INTERVAL_MS: u64 = 250;

pub struct Session {
    started: Instant,
    /// Files and totals of the passes already finished; a live pass adds its own on top.
    scanned: u32,
    total: u32,
    totals: LibrarySyncSummary,
    throttle: Mutex<ProgressThrottle>,
    delta: Mutex<DeltaBuffer>,
}

impl Session {
    pub fn new(now: Instant) -> Self {
        Self {
            started: now,
            scanned: 0,
            total: 0,
            totals: LibrarySyncSummary::default(),
            throttle: Mutex::new(ProgressThrottle::new(TICK_INTERVAL_MS)),
            delta: Mutex::new(DeltaBuffer::new(now)),
        }
    }

    /// Receives one report from a running pass.
    pub fn on_emit(&self, app: &AppHandle, state: &AppState, emit: ScanEmit) {
        match emit {
            ScanEmit::Progress(p) => {
                let tick = LibrarySyncTick {
                    running: true,
                    scanned: self.scanned + p.scanned,
                    total: self.total + p.total,
                    deferred: self.totals.deferred,
                };
                self.publish(app, state, tick, false);
            }
            ScanEmit::Changed(ids) => {
                if let Ok(mut delta) = self.delta.lock() {
                    delta.add(ids);
                }
            }
        }
        self.flush_delta(app, false);
    }

    /// Folds a finished pass into the running totals.
    pub fn absorb(&mut self, summary: &ScanSummary) {
        self.scanned += summary.seen;
        self.total += summary.total;
        let t = &mut self.totals;
        t.inserted += summary.inserted;
        t.updated += summary.updated;
        t.missing += summary.missing;
        t.returned += summary.returned;
        t.deferred += summary.deferred;
        t.errors += summary.errors;
        t.offline_roots.extend(&summary.offline_roots);
        t.offline_roots.sort_unstable();
        t.offline_roots.dedup();
    }

    /// Sends the pending delta when its interval has passed, or at once when `force`.
    pub fn flush_delta(&self, app: &AppHandle, force: bool) {
        let pending = match self.delta.lock() {
            Ok(mut delta) => delta.take(Instant::now(), force),
            Err(_) => None,
        };
        if let Some(delta) = pending {
            let _ = app.emit("library:delta", &delta);
        }
    }

    /// Closes the session: the last delta, the summary, then the final tick with `running` false.
    pub fn finish(self, app: &AppHandle, state: &AppState) {
        self.flush_delta(app, true);
        let _ = app.emit("library:summary", &self.totals);
        let tick = LibrarySyncTick {
            running: false,
            scanned: self.scanned,
            total: self.total,
            deferred: self.totals.deferred,
        };
        self.publish(app, state, tick, true);
    }

    /// Mirrors a tick into the status snapshot and emits it when the throttle allows.
    fn publish(&self, app: &AppHandle, state: &AppState, tick: LibrarySyncTick, terminal: bool) {
        if let Ok(mut status) = state.library_sync_status.lock() {
            status.running = tick.running;
            status.scanned = tick.scanned;
            status.total = tick.total;
        }
        let now_ms = self.started.elapsed().as_millis() as u64;
        let due = self
            .throttle
            .lock()
            .map(|mut t| t.should_emit(now_ms, terminal))
            .unwrap_or(terminal);
        if due {
            let _ = app.emit("library:sync", &tick);
        }
    }
}
