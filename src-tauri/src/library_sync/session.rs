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
        // The standing count is global, so the latest pass replaces it rather than adding.
        t.issues = summary.issues;
        t.new_issues += summary.issue_changes.iter().filter(|c| c.is_new).count() as u32;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::scan::{run_scan, ScanRoot};
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    // One whole-root pass over `dir`.
    fn pass(dir: &Path, db_path: &Path, at: i64) -> ScanSummary {
        let id = {
            let conn = db::open_db(db_path).unwrap();
            db::get_or_create_root(&conn, &dir.to_string_lossy(), 1)
                .unwrap()
                .0
        };
        let roots = [ScanRoot {
            id,
            path: dir.to_path_buf(),
            units: None,
        }];
        let cancel = Arc::new(AtomicBool::new(false));
        run_scan(&roots, db_path, &cancel, at, &HashMap::new(), |_| {}).unwrap()
    }

    fn totals(passes: &[&ScanSummary]) -> LibrarySyncSummary {
        let mut session = Session::new(Instant::now());
        for summary in passes {
            session.absorb(summary);
        }
        session.totals
    }

    #[test]
    fn the_summary_carries_the_standing_count_and_only_new_issues() {
        let base = std::env::temp_dir().join(format!(
            "plisto_sync_issues_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let music = base.join("music");
        std::fs::create_dir_all(&music).unwrap();
        std::fs::write(music.join("a.mp3"), b"").unwrap();
        std::fs::write(music.join("b.mp3"), b"").unwrap();
        let db_path = base.join("plisto.sqlite");

        let first = pass(&music, &db_path, 1000);
        let repeat = pass(&music, &db_path, 2000);
        let _ = std::fs::remove_dir_all(&base);

        let t = totals(&[&first]);
        assert_eq!((t.issues, t.new_issues), (2, 2));
        let t = totals(&[&repeat]);
        assert_eq!((t.issues, t.new_issues), (2, 0), "known issues are not new");
        let t = totals(&[&first, &repeat]);
        assert_eq!((t.issues, t.new_issues), (2, 2));

        let json = serde_json::to_value(&t).unwrap();
        assert_eq!((json["issues"].as_u64(), json["new_issues"].as_u64()), (Some(2), Some(2)));
    }
}
