/*
 * When restore points are taken. A point is staged under the caller's lock on a connection of its own,
 * which pins the library as it is, and finished on a worker thread so the action never waits for the
 * copy. Three triggers use it: a launch on a new app version, a daily check on the same worker, and the
 * destructive commands, which call `point_before` ahead of their transaction. Every take, skip, failure
 * and prune goes to boot.log; a point that cannot be taken never fails the action around it.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tauri::State;

// -- Local Imports --
use crate::bootlog::{BootLog, PointLine};
use crate::db::{self, restore_points as points};
use crate::state::AppState;
use points::{PointEntry, Reason, Staged, Taken, DIR_NAME};

/// The settings key holding the app version that last ran against this library.
const LAST_RUN_KEY: &str = "last_run_version";

/// How long the worker sleeps between daily checks.
const DAILY_CHECK: Duration = Duration::from_secs(60 * 60);

/// An action a point can be taken before, by the key the boot log records.
struct Action {
    key: &'static str,
    /// Whether the front end may ask for it through `take_point_before`.
    from_front_end: bool,
    /// Whether the action must not run without a saved point, so its point is finished before the
    /// caller continues.
    waits: bool,
}

const ACTIONS: &[Action] = &[
    Action { key: "tags_apply", from_front_end: false, waits: false },
    Action { key: "merge_duplicates", from_front_end: false, waits: false },
    Action { key: "delete_albums", from_front_end: true, waits: false },
    Action { key: "remove_root", from_front_end: false, waits: false },
    Action { key: "purge", from_front_end: false, waits: true },
    Action { key: "relocate", from_front_end: false, waits: false },
];

type Job = Box<dyn FnOnce() + Send>;

/// Takes an action point before the command's transaction begins. `state.db` must be locked by the
/// caller and idle, so the staged snapshot is the library as the action finds it. Returns whether the
/// point is saved or, for an action that does not wait, staged; an empty library counts as saved, since
/// it holds nothing to lose. Only an action that waits for its point has a caller that refuses on false.
pub fn point_before(state: &AppState, boot_log: &BootLog, action: &str) -> bool {
    point_before_at(&state.db_path, boot_log, action, now_ms(), spawn_worker)
}

fn point_before_at(
    db_path: &Path,
    log: &BootLog,
    action: &str,
    now_ms: i64,
    run: impl FnOnce(Job),
) -> bool {
    let Some(action) = ACTIONS.iter().find(|a| a.key == action) else {
        log_failed(log, Reason::Action, 0, &format!("unknown action {action}"));
        return false;
    };
    let staged = match stage_logged(db_path, log, Reason::Action, Some(action.key), now_ms) {
        Staging::Ready(staged) => staged,
        Staging::Empty => return true,
        Staging::Failed => return false,
    };
    if action.waits {
        return finish_logged(staged, log, Reason::Action, Some(action.key));
    }
    let log = log.clone();
    let key = action.key;
    run(Box::new(move || {
        finish_logged(staged, &log, Reason::Action, Some(key));
    }));
    true
}

/// Takes a point ahead of a multi-step change the front end drives itself. Only a key marked for the
/// front end is accepted. Returns whether the point is staged.
#[tauri::command]
pub async fn take_point_before(
    action: String,
    state: State<'_, AppState>,
    boot_log: State<'_, BootLog>,
) -> Result<bool, String> {
    if !ACTIONS.iter().any(|a| a.key == action && a.from_front_end) {
        return Err(format!("unknown restore point action: {action}"));
    }
    let _conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    Ok(point_before(&state, &boot_log, &action))
}

// ---- Launch and daily points ----

/// What the launch left to do for the version point.
enum VersionStep {
    /// This version already ran, or the stored value could not be read.
    Current,
    /// An empty library: nothing to save, only the version to record.
    Record,
    /// A staged point to finish, then the version to record.
    Finish(Box<Staged>, Option<String>),
}

/// Stages the version point when the running version differs from the last one, on the calling thread
/// and before anything writes, then hands the rest to `run`: finishing the point, recording the
/// version only once it is saved, and the daily checks. A point that cannot be staged leaves the stored
/// version alone, so the next launch tries again. Never blocks on the copy.
pub fn start(conn: &Connection, db_path: &Path, log: &BootLog) {
    start_with(conn, db_path, log, env!("CARGO_PKG_VERSION"), now_ms(), spawn_worker);
}

fn start_with(
    conn: &Connection,
    db_path: &Path,
    log: &BootLog,
    running: &str,
    now_ms: i64,
    run: impl FnOnce(Job),
) {
    let step = match db::get_setting(conn, LAST_RUN_KEY) {
        Ok(last) if !points::version_point_due(last.as_deref(), running) => VersionStep::Current,
        Ok(last) => match stage_logged(db_path, log, Reason::Version, last.as_deref(), now_ms) {
            Staging::Ready(staged) => VersionStep::Finish(staged, last),
            Staging::Empty => VersionStep::Record,
            Staging::Failed => VersionStep::Current,
        },
        Err(e) => {
            log_failed(log, Reason::Version, 0, &e.to_string());
            VersionStep::Current
        }
    };
    let db_path = db_path.to_path_buf();
    let log = log.clone();
    let running = running.to_string();
    run(Box::new(move || {
        worker(&db_path, &log, &running, step, || {
            std::thread::sleep(DAILY_CHECK);
            true
        });
    }));
}

// Finishes the version point, then checks the daily ring at once and after each `wait` that returns
// true.
fn worker(
    db_path: &Path,
    log: &BootLog,
    running: &str,
    step: VersionStep,
    mut wait: impl FnMut() -> bool,
) {
    version_step(db_path, log, running, step);
    let mut skipped = None;
    loop {
        daily_tick(db_path, log, now_ms(), &mut skipped);
        if !wait() {
            break;
        }
    }
}

fn version_step(db_path: &Path, log: &BootLog, running: &str, step: VersionStep) {
    let saved = match step {
        VersionStep::Current => return,
        VersionStep::Record => true,
        VersionStep::Finish(staged, last) => {
            finish_logged(staged, log, Reason::Version, last.as_deref())
        }
    };
    if !saved {
        return;
    }
    let recorded = db::open_db(db_path)
        .and_then(|conn| db::set_setting(&conn, LAST_RUN_KEY, running));
    if let Err(e) = recorded {
        log_failed(log, Reason::Version, 0, &e.to_string());
    }
}

// One daily check. A tick that is not due logs nothing. A due check that skips or fails logs once per
// cause, so an idle library or a lasting failure does not add a line an hour. `last` remembers the
// cause last logged and is cleared by a take.
fn daily_tick(db_path: &Path, log: &BootLog, now_ms: i64, last: &mut Option<String>) {
    let dir = points_dir(db_path);
    let listed: Vec<PointEntry> = match points::list(&dir) {
        Ok(listed) => listed,
        Err(e) => return daily_failed(log, last, 0, &e.to_string()),
    };
    if !points::daily_due(&listed, now_ms) {
        return;
    }
    let conn = match db::open_db(db_path) {
        Ok(conn) => conn,
        Err(e) => return daily_failed(log, last, 0, &e.to_string()),
    };
    let live = match points::live_hash(&conn) {
        Ok(live) => live,
        Err(e) => return daily_failed(log, last, 0, &e.to_string()),
    };
    if points::newest_content_hash(&listed) == Some(live.as_str()) {
        return log_daily_once(log, last, format!("unchanged:{live}"), &PointLine::Skipped { why: "unchanged" });
    }
    match points::take(&conn, &dir, Reason::Daily, None, now_ms) {
        Ok(Some(taken)) => {
            *last = None;
            log_taken(log, Reason::Daily, None, &taken);
        }
        Ok(None) => log_daily_once(log, last, "empty".to_string(), &PointLine::Skipped { why: "empty" }),
        Err(e) => daily_failed(log, last, e.ms, &e.error),
    }
}

fn daily_failed(log: &BootLog, last: &mut Option<String>, ms: u64, error: &str) {
    log_daily_once(log, last, format!("failed:{error}"), &PointLine::Failed { ms, error });
}

fn log_daily_once(log: &BootLog, last: &mut Option<String>, cause: String, event: &PointLine) {
    if last.as_deref() != Some(cause.as_str()) {
        log.log_point(Reason::Daily.as_str(), event);
        *last = Some(cause);
    }
}

// ---- Shared steps ----

enum Staging {
    Ready(Box<Staged>),
    Empty,
    Failed,
}

// Stages a point on a connection of its own, logging a skip for an empty library and a failure.
fn stage_logged(
    db_path: &Path,
    log: &BootLog,
    reason: Reason,
    detail: Option<&str>,
    now_ms: i64,
) -> Staging {
    let conn = match db::open_db(db_path) {
        Ok(conn) => conn,
        Err(e) => {
            log_failed(log, reason, 0, &e.to_string());
            return Staging::Failed;
        }
    };
    match points::stage(conn, &points_dir(db_path), reason, detail, now_ms) {
        Ok(Some(staged)) => Staging::Ready(Box::new(staged)),
        Ok(None) => {
            log.log_point(reason.as_str(), &PointLine::Skipped { why: "empty" });
            Staging::Empty
        }
        Err(e) => {
            log_failed(log, reason, e.ms, &e.error);
            Staging::Failed
        }
    }
}

// Finishes a staged point and logs the outcome. True when the point is saved.
fn finish_logged(
    staged: Box<Staged>,
    log: &BootLog,
    reason: Reason,
    detail: Option<&str>,
) -> bool {
    match points::finish(*staged) {
        Ok(taken) => {
            log_taken(log, reason, detail, &taken);
            true
        }
        Err(e) => {
            log_failed(log, reason, e.ms, &e.error);
            false
        }
    }
}

fn log_taken(log: &BootLog, reason: Reason, detail: Option<&str>, taken: &Taken) {
    let name = reason.as_str();
    log.log_point(
        name,
        &PointLine::Taken {
            ms: taken.ms,
            bytes: taken.bytes,
            file: &taken.file,
            detail,
        },
    );
    match &taken.pruned {
        Ok(pruned) if pruned.removed > 0 => log.log_point(
            name,
            &PointLine::Pruned {
                removed: pruned.removed,
                kept: pruned.kept,
            },
        ),
        Ok(_) => {}
        Err(e) => log_failed(log, reason, 0, &format!("prune: {e}")),
    }
}

fn log_failed(log: &BootLog, reason: Reason, ms: u64, error: &str) {
    log.log_point(reason.as_str(), &PointLine::Failed { ms, error });
}

fn points_dir(db_path: &Path) -> PathBuf {
    db_path.with_file_name(DIR_NAME)
}

fn spawn_worker(job: Job) {
    // A thread that cannot start drops the job, which removes a staged point's `.tmp`.
    let _ = std::thread::Builder::new()
        .name("restore-point".to_string())
        .spawn(job);
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A fresh temp folder removed on drop. Declared before the connections and jobs that use it, it
    // drops after them, so nothing holds a file open when the folder goes.
    struct Scratch(PathBuf);

    impl std::ops::Deref for Scratch {
        type Target = PathBuf;
        fn deref(&self) -> &PathBuf {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(tag: &str) -> Scratch {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "plisto_rpt_{tag}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    // A file-backed library with one album, in a fresh folder, plus its boot log.
    fn library(tag: &str) -> (Scratch, PathBuf, Connection, BootLog) {
        let dir = temp_dir(tag);
        let path = dir.join("plisto.sqlite");
        let conn = db::open_db(&path).unwrap();
        add_album(&conn, 1);
        let log = BootLog::new(dir.to_path_buf());
        (dir, path, conn, log)
    }

    fn add_album(conn: &Connection, id: i64) {
        conn.execute(
            "INSERT INTO albums (id, title, created_at, updated_at, kind) VALUES (?1, 'A', 1, 1, 'album')",
            [id],
        )
        .unwrap();
    }

    fn log_text(dir: &Path) -> String {
        fs::read_to_string(dir.join("boot.log")).unwrap_or_default()
    }

    fn point_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir.join(DIR_NAME))
            .map(|rd| {
                rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    fn albums_in(point: &Path) -> i64 {
        Connection::open(point)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn only_marked_actions_are_taken_from_the_front_end() {
        let front: Vec<&str> = ACTIONS
            .iter()
            .filter(|a| a.from_front_end)
            .map(|a| a.key)
            .collect();
        assert_eq!(front, ["delete_albums"]);
        let keys: Vec<&str> = ACTIONS.iter().map(|a| a.key).collect();
        for key in ["tags_apply", "merge_duplicates", "remove_root", "purge", "relocate"] {
            assert!(keys.contains(&key), "{key}");
        }
        assert_eq!(ACTIONS.iter().filter(|a| a.waits).count(), 1);
        assert!(ACTIONS.iter().find(|a| a.key == "purge").unwrap().waits);
    }

    #[test]
    fn the_action_point_is_staged_before_the_action_and_finished_after() {
        let (dir, path, conn, log) = library("stage_first");
        let jobs = RefCell::new(Vec::new());
        let saved = point_before_at(&path, &log, "delete_albums", 1000, |job| {
            jobs.borrow_mut().push(job)
        });
        assert!(saved);
        // The action runs now; the point has not been finished yet.
        conn.execute("DELETE FROM albums", []).unwrap();
        assert!(point_files(&dir).iter().all(|n| n.ends_with(".tmp")));
        for job in jobs.into_inner() {
            job();
        }
        let files = point_files(&dir);
        assert_eq!(files, ["rp-1000-action.sqlite"]);
        assert_eq!(albums_in(&dir.join(DIR_NAME).join(&files[0])), 1);
        assert!(log_text(&dir).contains(" POINT action taken "));
        assert!(log_text(&dir).contains("detail=delete_albums"));
    }

    #[test]
    fn an_action_that_waits_has_its_point_saved_when_the_call_returns() {
        let (dir, path, _conn, log) = library("waits");
        let saved = point_before_at(&path, &log, "purge", 2000, |_| {
            panic!("a waiting action finishes on the calling thread")
        });
        assert!(saved);
        assert_eq!(point_files(&dir), ["rp-2000-action.sqlite"]);
    }

    #[test]
    fn a_point_that_cannot_be_staged_reports_false_and_logs_the_failure() {
        let (dir, path, _conn, log) = library("fails");
        // A file squatting the folder name makes the folder impossible to create.
        fs::write(dir.join(DIR_NAME), b"x").unwrap();
        assert!(!point_before_at(&path, &log, "tags_apply", 1, |_| {}));
        assert!(!point_before_at(&path, &log, "purge", 1, |_| {}));
        assert_eq!(log_text(&dir).matches(" POINT action failed ").count(), 2);
    }

    #[test]
    fn an_unknown_action_is_refused_and_an_empty_library_counts_as_saved() {
        let (dir, path, conn, log) = library("unknown");
        assert!(!point_before_at(&path, &log, "format_disk", 1, |_| {}));
        conn.execute("DELETE FROM albums", []).unwrap();
        assert!(point_before_at(&path, &log, "purge", 1, |_| {}));
        assert!(point_files(&dir).is_empty());
        assert!(log_text(&dir).contains(" POINT action skipped why=empty"));
    }

    #[test]
    fn a_new_version_stages_inline_and_records_the_version_after_the_point_is_saved() {
        let (dir, path, conn, log) = library("version");
        db::set_setting(&conn, LAST_RUN_KEY, "0.0.1").unwrap();
        let jobs = RefCell::new(Vec::new());
        start_with(&conn, &path, &log, "9.9.9", 5000, |job| jobs.borrow_mut().push(job));
        // Returned with the copy undone and the old version still stored.
        assert_eq!(jobs.borrow().len(), 1);
        assert!(point_files(&dir).iter().all(|n| n.ends_with(".tmp")));
        assert_eq!(db::get_setting(&conn, LAST_RUN_KEY).unwrap().as_deref(), Some("0.0.1"));

        let step = VersionStep::Finish(
            match stage_logged(&path, &log, Reason::Version, Some("0.0.1"), 5001) {
                Staging::Ready(staged) => staged,
                _ => panic!("expected a staged point"),
            },
            Some("0.0.1".to_string()),
        );
        version_step(&path, &log, "9.9.9", step);
        assert_eq!(db::get_setting(&conn, LAST_RUN_KEY).unwrap().as_deref(), Some("9.9.9"));
        assert!(point_files(&dir).iter().any(|n| n.ends_with("-version.sqlite")));
        assert!(log_text(&dir).contains("detail=0.0.1"));
    }

    #[test]
    fn the_same_version_takes_no_point_and_a_first_run_takes_one() {
        let (dir, path, conn, log) = library("same");
        db::set_setting(&conn, LAST_RUN_KEY, "1.0.0").unwrap();
        start_with(&conn, &path, &log, "1.0.0", 1, |_| {});
        assert!(point_files(&dir).is_empty());

        let (dir2, path2, conn2, log2) = library("first");
        let jobs = RefCell::new(Vec::new());
        start_with(&conn2, &path2, &log2, "1.0.0", 1, |job| jobs.borrow_mut().push(job));
        assert_eq!(point_files(&dir2), ["rp-1-version.tmp"]);
    }

    #[test]
    fn a_point_that_cannot_be_staged_keeps_the_old_version_and_never_blocks_launch() {
        let (dir, path, conn, log) = library("keeps");
        db::set_setting(&conn, LAST_RUN_KEY, "0.0.1").unwrap();
        fs::write(dir.join(DIR_NAME), b"x").unwrap();
        let ran = RefCell::new(0);
        // The job is dropped unrun: the worker's daily loop never ends.
        start_with(&conn, &path, &log, "9.9.9", 1, |_job| *ran.borrow_mut() += 1);
        assert_eq!(*ran.borrow(), 1);
        assert_eq!(db::get_setting(&conn, LAST_RUN_KEY).unwrap().as_deref(), Some("0.0.1"));
        assert!(log_text(&dir).contains(" POINT version failed "));
    }

    #[test]
    fn a_point_that_fails_to_finish_keeps_the_old_version() {
        let (dir, path, conn, log) = library("finish_fails");
        db::set_setting(&conn, LAST_RUN_KEY, "0.0.1").unwrap();
        let staged = match stage_logged(&path, &log, Reason::Version, Some("0.0.1"), 7) {
            Staging::Ready(staged) => staged,
            _ => panic!("expected a staged point"),
        };
        // A folder squatting the final name makes the rename fail.
        fs::create_dir(dir.join(DIR_NAME).join("rp-7-version.sqlite")).unwrap();
        version_step(&path, &log, "9.9.9", VersionStep::Finish(staged, Some("0.0.1".to_string())));
        assert_eq!(db::get_setting(&conn, LAST_RUN_KEY).unwrap().as_deref(), Some("0.0.1"));
        assert!(log_text(&dir).contains(" POINT version failed "));
        assert!(point_files(&dir).iter().all(|n| !n.ends_with(".tmp")));
    }

    #[test]
    fn an_empty_library_records_the_version_without_a_point() {
        let dir = temp_dir("empty_version");
        let path = dir.join("plisto.sqlite");
        let conn = db::open_db(&path).unwrap();
        let log = BootLog::new(dir.to_path_buf());
        let jobs = RefCell::new(Vec::new());
        start_with(&conn, &path, &log, "2.0.0", 1, |job| jobs.borrow_mut().push(job));
        version_step(&path, &log, "2.0.0", VersionStep::Record);
        assert_eq!(db::get_setting(&conn, LAST_RUN_KEY).unwrap().as_deref(), Some("2.0.0"));
        assert!(point_files(&dir).is_empty());
        assert!(log_text(&dir).contains(" POINT version skipped why=empty"));
    }

    #[test]
    fn the_worker_checks_daily_at_once_then_after_each_wait() {
        let (dir, path, _conn, log) = library("worker");
        let mut waits = 0;
        worker(&path, &log, "1.0.0", VersionStep::Current, || {
            waits += 1;
            waits < 3
        });
        assert_eq!(waits, 3);
        // One take on the first check; the later checks find nothing due.
        assert_eq!(
            point_files(&dir).iter().filter(|n| n.ends_with("-daily.sqlite")).count(),
            1
        );
        assert_eq!(log_text(&dir).matches(" POINT daily taken ").count(), 1);
    }

    #[test]
    fn a_lasting_daily_failure_logs_once() {
        let (dir, path, _conn, log) = library("daily_fail");
        fs::write(dir.join(DIR_NAME), b"x").unwrap();
        let mut last = None;
        daily_tick(&path, &log, 10, &mut last);
        daily_tick(&path, &log, 20, &mut last);
        assert_eq!(log_text(&dir).matches(" POINT daily failed ").count(), 1);
    }

    #[test]
    fn a_due_daily_with_unchanged_data_skips_and_logs_once() {
        let (dir, path, conn, log) = library("daily_skip");
        // A version point holds the current data, so a due daily is a duplicate.
        let live = points::live_hash(&conn).unwrap();
        points::take(&conn, &dir.join(DIR_NAME), Reason::Version, None, 1).unwrap();
        let day = points::DAILY_INTERVAL_MS;
        let mut skipped = None;
        daily_tick(&path, &log, day + 10, &mut skipped);
        daily_tick(&path, &log, day + 20, &mut skipped);
        assert_eq!(log_text(&dir).matches(" POINT daily skipped why=unchanged").count(), 1);
        assert!(point_files(&dir).iter().all(|n| !n.ends_with("-daily.sqlite")));

        // New data makes the next due check take a point.
        add_album(&conn, 2);
        assert_ne!(points::live_hash(&conn).unwrap(), live);
        daily_tick(&path, &log, day + 30, &mut skipped);
        assert!(point_files(&dir).iter().any(|n| n.ends_with("-daily.sqlite")));
        assert!(skipped.is_none());
        // Not a day later: nothing is attempted, nothing logged.
        let lines = log_text(&dir).lines().count();
        daily_tick(&path, &log, day + 40, &mut skipped);
        assert_eq!(log_text(&dir).lines().count(), lines);
    }
}
