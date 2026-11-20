/*
 * The IPC surface for restoring a restore point: the list with the folder's disk use, a dry run, and
 * the restore itself. A restore replaces the library's organization, so it runs under the scan lock
 * and is refused while a user scan or a write to a music file runs; an export may run meanwhile,
 * since it works from a snapshot of its own. A point is named by its bare file name inside the
 * points folder, never by a path.
 */

// -- Library Imports --
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::State;

// -- Local Imports --
use super::file_writes::refuse_while_writing;
use super::organize::with_scan_guard;
use super::restore_points::{log_failed, log_taken};
use crate::bootlog::{BootLog, PointLine, RestoreLine};
use crate::db::restore_points::{
    self as points, Applied, LoadedPoint, PointEntry, PointError, PointStatus, Reason,
    RestoreError, Taken,
};
use crate::dto::{
    RestoreOutcome, RestorePointList, RestorePointRow, RestorePointStatus, RestorePreview,
    RestoreRefusal,
};
use crate::scan_lock::WRITE_BUSY;
use crate::state::AppState;

/// Every restore point, newest first, with the folder's point count and total size. A point that does
/// not open is listed as unreadable, one from a later format as newer. Reads files only, off the
/// runtime thread.
#[tauri::command]
pub async fn list_restore_points(state: State<'_, AppState>) -> Result<RestorePointList, String> {
    let dir = points::points_dir(&state.db_path);
    tauri::async_runtime::spawn_blocking(move || list_in(&dir))
        .await
        .map_err(|_| "restore point list failed to run".to_string())?
}

/// What restoring `file` would bring back and lose. Writes nothing; the restore plans again.
#[tauri::command]
pub async fn plan_restore(
    file: String,
    state: State<'_, AppState>,
) -> Result<RestorePreview, String> {
    plan(&state, &file).await
}

/// Replaces the library's organization with the point `file`, after saving a point of the library as
/// it is, whose file name comes back for undo. A refusal changes nothing.
#[tauri::command]
pub async fn restore_from_point(
    file: String,
    state: State<'_, AppState>,
    boot_log: State<'_, BootLog>,
) -> Result<RestoreOutcome, String> {
    restore(&state, &boot_log, &file, now_ms()).await
}

// Reads and checks the point on a blocking thread, holding no lock: the file is the slow part.
async fn load(path: PathBuf) -> Result<Result<LoadedPoint, RestoreError>, String> {
    tauri::async_runtime::spawn_blocking(move || points::load_point(&path))
        .await
        .map_err(|_| "restore point read failed to run".to_string())
}

fn list_in(dir: &Path) -> Result<RestorePointList, String> {
    let listed = points::list(dir).map_err(|e| e.to_string())?;
    let disk = points::disk_use(dir).map_err(|e| e.to_string())?;
    Ok(RestorePointList {
        points: listed.into_iter().map(point_row).collect(),
        disk_points: disk.points as u64,
        disk_bytes: disk.bytes,
    })
}

fn point_row(entry: PointEntry) -> RestorePointRow {
    let status = match entry.status {
        PointStatus::Ready(meta) => RestorePointStatus::Ready {
            app_version: meta.app_version,
            detail: meta.detail,
            albums: meta.albums,
            singles: meta.singles,
            playlists: meta.playlists,
            filed_tracks: meta.filed_tracks,
            edited_tracks: meta.edited_tracks,
            genre_tracks: meta.genre_tracks,
        },
        PointStatus::Newer { format } => RestorePointStatus::Newer { format },
        PointStatus::Unreadable { error } => RestorePointStatus::Unreadable { error },
    };
    RestorePointRow {
        file: entry.file,
        reason: entry.reason.as_str().to_string(),
        created_at: entry.created_at,
        bytes: entry.bytes,
        status,
    }
}

async fn plan(state: &AppState, file: &str) -> Result<RestorePreview, String> {
    let path = point_path(&state.db_path, file)?;
    let planned = match load(path).await? {
        Ok(loaded) => {
            let conn = state
                .db
                .lock()
                .map_err(|_| "index is unavailable".to_string())?;
            points::plan_restore(&conn, &loaded)
        }
        Err(e) => Err(e),
    };
    match planned {
        Ok(summary) => Ok(RestorePreview::Ready { summary }),
        Err(e) => match refusal(&e) {
            Some(reason) => Ok(RestorePreview::Refused { reason }),
            None => Err(e.to_string()),
        },
    }
}

async fn restore(
    state: &AppState,
    log: &BootLog,
    file: &str,
    now_ms: i64,
) -> Result<RestoreOutcome, String> {
    let path = point_path(&state.db_path, file)?;
    let dir = points::points_dir(&state.db_path);
    let started = Instant::now();
    let loaded = match load(path).await? {
        Ok(loaded) => loaded,
        Err(e) => return outcome(log, file, started, Err(e)),
    };
    let mut ran = false;
    let result = with_scan_guard(state, |conn| {
        refuse_while_writing(state)?;
        ran = true;
        Ok(points::apply_restore(conn, &loaded, &dir, now_ms, |taken| {
            log_before_point(log, file, taken)
        }))
    });
    match result {
        Ok(applied) => outcome(log, file, started, applied),
        // The guard gave up before the restore began: a scan or a file write holds the lock.
        Err(e) if !ran && !state.db.is_poisoned() => {
            let (why, reason) = if e == WRITE_BUSY {
                ("file_write", RestoreRefusal::FileWrite)
            } else {
                ("busy", RestoreRefusal::Busy)
            };
            log.log_restore(file, &RestoreLine::Refused { why });
            Ok(RestoreOutcome::Refused { reason })
        }
        Err(e) => {
            let ms = started.elapsed().as_millis() as u64;
            log.log_restore(file, &RestoreLine::Failed { ms, error: &e });
            Err(e)
        }
    }
}

// Logs a restore's end and shapes it for the front end.
fn outcome(
    log: &BootLog,
    file: &str,
    started: Instant,
    applied: Result<Applied, RestoreError>,
) -> Result<RestoreOutcome, String> {
    let ms = started.elapsed().as_millis() as u64;
    match applied {
        Ok(applied) => {
            let s = &applied.summary;
            log.log_restore(
                file,
                &RestoreLine::Ok {
                    ms,
                    albums: s.albums,
                    singles: s.singles,
                    playlists: s.playlists,
                    unmatched: s.unmatched_tracks,
                    collapsed: s.collapsed,
                    dropped: s.dropped_entries,
                },
            );
            Ok(RestoreOutcome::Done {
                summary: applied.summary,
                before_point: applied.before.map(|t| t.file),
            })
        }
        Err(e) => match (e.refusal(), refusal(&e)) {
            (Some(why), Some(reason)) => {
                log.log_restore(file, &RestoreLine::Refused { why });
                Ok(RestoreOutcome::Refused { reason })
            }
            _ => {
                let error = e.to_string();
                log.log_restore(file, &RestoreLine::Failed { ms, error: &error });
                Err(error)
            }
        },
    }
}

// The before-restore point's lines, through the helpers every other point logs with.
fn log_before_point(log: &BootLog, file: &str, taken: &Result<Option<Taken>, PointError>) {
    match taken {
        Ok(Some(taken)) => log_taken(log, Reason::Restore, Some(file), taken),
        Ok(None) => log.log_point(
            Reason::Restore.as_str(),
            &PointLine::Skipped { why: "empty" },
        ),
        Err(e) => log_failed(log, Reason::Restore, e.ms, &e.error),
    }
}

fn refusal(e: &RestoreError) -> Option<RestoreRefusal> {
    match e {
        RestoreError::Newer { format } => Some(RestoreRefusal::Newer { format: *format }),
        RestoreError::Unreadable(m) => Some(RestoreRefusal::Unreadable { message: m.clone() }),
        RestoreError::Integrity(m) => Some(RestoreRefusal::Integrity { message: m.clone() }),
        RestoreError::BeforePoint(m) => Some(RestoreRefusal::BeforePoint { message: m.clone() }),
        RestoreError::Failed(_) => None,
    }
}

// The point `file` names: a bare point file name, resolved inside the points folder only.
fn point_path(db_path: &Path, file: &str) -> Result<PathBuf, String> {
    let bare = !file.contains(['/', '\\', ':'])
        && !file.contains("..")
        && Path::new(file).file_name() == Some(OsStr::new(file));
    if !bare || !points::is_point_name(file) {
        return Err(format!("not a restore point: {file}"));
    }
    Ok(points::points_dir(db_path).join(file))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::scan_lock::{acquire_scan_lock, Holder};
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A fresh temp folder removed on drop. Declared before the state that holds a connection into it,
    // it drops after that state, so nothing holds a file open when the folder goes.
    struct Scratch(PathBuf);

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(tag: &str) -> Scratch {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "plisto_restore_cmd_{tag}_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    // A file-backed library with two albums, its state and boot log.
    fn library(dir: &Path) -> (AppState, BootLog) {
        let db_path = dir.join("plisto.sqlite");
        let conn = db::open_db(&db_path).unwrap();
        conn.execute_batch(
            "INSERT INTO albums (id, title, created_at, updated_at, kind) VALUES
                (1, 'One', 1, 1, 'album'), (2, 'Two', 1, 1, 'album');",
        )
        .unwrap();
        let mut state = AppState::for_test(conn, PathBuf::new());
        state.db_path = db_path;
        (state, BootLog::new(dir.to_path_buf()))
    }

    fn titles(state: &AppState) -> Vec<String> {
        let conn = state.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT title FROM albums ORDER BY id").unwrap();
        let titles = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();
        titles
    }

    fn take_daily(state: &AppState, now_ms: i64) -> String {
        let conn = state.db.lock().unwrap();
        points::take(&conn, &points::points_dir(&state.db_path), Reason::Daily, None, now_ms)
            .unwrap()
            .unwrap()
            .file
    }

    fn log_text(dir: &Path) -> String {
        fs::read_to_string(dir.join("boot.log")).unwrap_or_default()
    }

    // The async command bodies, run to completion.
    fn restore(
        state: &AppState,
        log: &BootLog,
        file: &str,
        now_ms: i64,
    ) -> Result<RestoreOutcome, String> {
        tauri::async_runtime::block_on(super::restore(state, log, file, now_ms))
    }

    fn plan(state: &AppState, file: &str) -> Result<RestorePreview, String> {
        tauri::async_runtime::block_on(super::plan(state, file))
    }

    #[test]
    fn a_restore_saves_a_point_first_and_returns_it_for_undo() {
        let dir = scratch("undo");
        let (state, log) = library(&dir.0);
        let file = take_daily(&state, 1000);
        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM albums WHERE id = 2", [])
            .unwrap();

        let RestoreOutcome::Done {
            summary,
            before_point,
        } = restore(&state, &log, &file, 2000).unwrap()
        else {
            panic!("the restore is done");
        };
        assert_eq!(summary.albums, 2);
        assert_eq!(titles(&state), ["One", "Two"]);
        let before = before_point.expect("a point of the library before the restore");
        assert_eq!(before, "rp-2000-restore.sqlite");

        // Restoring that point undoes the restore.
        restore(&state, &log, &before, 3000).unwrap();
        assert_eq!(titles(&state), ["One"]);

        let text = log_text(&dir.0);
        assert!(text.contains(" POINT restore taken ms="));
        assert!(text.contains(&format!("detail={file}")));
        assert!(text.contains(&format!(" RESTORE {file} ok ms=")));
        assert!(text.contains(" albums=2 singles=0 playlists=0 unmatched=0 collapsed=0 dropped=0"));

        let listed = list_in(&points::points_dir(&state.db_path)).unwrap();
        let files: Vec<&str> = listed.points.iter().map(|p| p.file.as_str()).collect();
        assert_eq!(
            files,
            ["rp-3000-restore.sqlite", "rp-2000-restore.sqlite", "rp-1000-daily.sqlite"]
        );
        assert_eq!(listed.disk_points, 3);
        assert_eq!(listed.disk_bytes, listed.points.iter().map(|p| p.bytes).sum::<u64>());
    }

    #[test]
    fn a_running_scan_refuses_the_restore() {
        let dir = scratch("busy");
        let (state, log) = library(&dir.0);
        let file = take_daily(&state, 1000);
        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM albums WHERE id = 2", [])
            .unwrap();

        let scan = acquire_scan_lock(&state, Holder::User).unwrap();
        let outcome = restore(&state, &log, &file, 2000).unwrap();
        assert_eq!(
            outcome,
            RestoreOutcome::Refused {
                reason: RestoreRefusal::Busy
            }
        );
        drop(scan);
        assert_eq!(titles(&state), ["One"]);
        assert!(log_text(&dir.0).contains(&format!(" RESTORE {file} refused why=busy")));
        assert_eq!(
            list_in(&points::points_dir(&state.db_path)).unwrap().points.len(),
            1,
            "no point is taken for a refused restore"
        );
    }

    #[test]
    fn a_running_file_write_refuses_the_restore_with_its_own_code() {
        let dir = scratch("file_write");
        let (state, log) = library(&dir.0);
        let file = take_daily(&state, 1000);
        state
            .db
            .lock()
            .unwrap()
            .execute("DELETE FROM albums WHERE id = 2", [])
            .unwrap();
        let refused = RestoreOutcome::Refused {
            reason: RestoreRefusal::FileWrite,
        };

        // A batch between two files holds no lock, but its write is still running.
        state.file_write_running.store(true, Ordering::SeqCst);
        assert_eq!(restore(&state, &log, &file, 2000).unwrap(), refused);

        assert_eq!(titles(&state), ["One"]);
        assert!(log_text(&dir.0).contains(&format!(" RESTORE {file} refused why=file_write")));
        assert_eq!(
            serde_json::to_value(RestoreRefusal::FileWrite).unwrap(),
            serde_json::json!({ "code": "file_write" })
        );
    }

    #[test]
    fn only_a_bare_point_name_is_accepted() {
        let dir = scratch("names");
        let (state, log) = library(&dir.0);
        for name in [
            "../plisto.sqlite",
            "..\\rp-1-daily.sqlite",
            "sub/rp-1-daily.sqlite",
            "sub\\rp-1-daily.sqlite",
            "C:rp-1-daily.sqlite",
            "/rp-1-daily.sqlite",
            "plisto.sqlite",
            "rp-1-daily.tmp",
            "rp-1-weekly.sqlite",
            "",
        ] {
            assert!(point_path(&state.db_path, name).is_err(), "{name}");
            assert!(restore(&state, &log, name, 1).is_err(), "{name}");
            assert!(plan(&state, name).is_err(), "{name}");
        }
        assert_eq!(
            point_path(&state.db_path, "rp-1-daily.sqlite").unwrap(),
            dir.0.join(points::DIR_NAME).join("rp-1-daily.sqlite")
        );
        assert_eq!(titles(&state), ["One", "Two"]);
    }

    #[test]
    fn an_unreadable_point_is_refused_by_the_plan_and_the_restore() {
        let dir = scratch("unreadable");
        let (state, log) = library(&dir.0);
        let points_dir = points::points_dir(&state.db_path);
        fs::create_dir_all(&points_dir).unwrap();
        fs::write(points_dir.join("rp-5-daily.sqlite"), b"not a database").unwrap();

        assert!(matches!(
            plan(&state, "rp-5-daily.sqlite").unwrap(),
            RestorePreview::Refused {
                reason: RestoreRefusal::Unreadable { .. }
            }
        ));
        assert!(matches!(
            restore(&state, &log, "rp-5-daily.sqlite", 1).unwrap(),
            RestoreOutcome::Refused {
                reason: RestoreRefusal::Unreadable { .. }
            }
        ));
        // A missing file is unreadable too.
        assert!(matches!(
            plan(&state, "rp-6-daily.sqlite").unwrap(),
            RestorePreview::Refused {
                reason: RestoreRefusal::Unreadable { .. }
            }
        ));
        assert!(log_text(&dir.0).contains(" RESTORE rp-5-daily.sqlite refused why=unreadable"));
        assert_eq!(titles(&state), ["One", "Two"]);
    }

    #[test]
    fn the_wire_shape_is_snake_case_and_tagged() {
        let refused = RestoreOutcome::Refused {
            reason: RestoreRefusal::BeforePoint {
                message: "disk full".to_string(),
            },
        };
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            serde_json::json!({
                "kind": "refused",
                "reason": { "code": "before_point", "message": "disk full" }
            })
        );
        let dir = scratch("wire");
        let (state, _log) = library(&dir.0);
        take_daily(&state, 1000);
        let listed = serde_json::to_value(list_in(&points::points_dir(&state.db_path)).unwrap())
            .unwrap();
        let row = &listed["points"][0];
        assert_eq!(row["file"], "rp-1000-daily.sqlite");
        assert_eq!(row["reason"], "daily");
        assert_eq!(row["status"]["kind"], "ready");
        assert_eq!(row["status"]["albums"], 2);
        assert!(listed["disk_bytes"].as_u64().unwrap() > 0);
    }
}
