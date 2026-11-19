/*
 * The IPC command for purging gone tracks: a confirmation-gated DELETE of rows the scan flagged
 * gone (missing_at set), plus the emptied-container sweep. It takes the same scan lock the root
 * commands hold, so a purge never races a scan on the WAL. The DELETE itself guards on
 * `missing_at IS NOT NULL`, so a present track passed by id is safe. A restore point is saved before
 * the delete, and the purge is the one action that refuses to run without it.
 */

// -- Library Imports --
use rusqlite::Connection;
use tauri::State;

// -- Local Imports --
use super::restore_points::point_before;
use crate::bootlog::BootLog;
use crate::db;
use crate::dto::PurgeSummary;
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

/// The error a purge returns when its restore point could not be saved. The frontend shows an
/// invoke error's text as it arrives.
const NOT_REMOVED: &str = "Nothing was removed: a restore point could not be saved first.";

/// Removes the gone tracks in `track_ids` and reports the tally: rows dropped and albums emptied by the
/// cascade. Rejects while a scan runs. Only rows already flagged gone are dropped; a present track passed
/// by id is left in place. Saves a restore point first and removes nothing when that fails. No walk. Async
/// so the wait for a preempted background pass never holds the main thread.
#[tauri::command]
pub async fn remove_missing_tracks(
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
    boot_log: State<'_, BootLog>,
) -> Result<PurgeSummary, String> {
    let _lock = acquire_scan_lock(&state, Holder::User)?;
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    purge_with_point(&mut conn, &track_ids, || {
        point_before(&state, &boot_log, "purge")
    })
}

/// Runs the purge once `point_saved` reports a saved point. An empty id list removes nothing, so it
/// takes no point.
pub(super) fn purge_with_point(
    conn: &mut Connection,
    track_ids: &[i64],
    point_saved: impl FnOnce() -> bool,
) -> Result<PurgeSummary, String> {
    if !track_ids.is_empty() && !point_saved() {
        return Err(NOT_REMOVED.to_string());
    }
    db::remove_missing_tracks(conn, track_ids).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gone_track(conn: &Connection, source: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 has_embedded_cover, scanned_at, missing_at)
             VALUES (?1, ?1, 'a.mp3', 'mp3', 1, 1, 0, 1, 5)",
            [source],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn track_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn an_unsaved_point_refuses_the_purge_and_removes_nothing() {
        let mut conn = db::open_in_memory().unwrap();
        let id = gone_track(&conn, "/m/a.mp3");
        let err = purge_with_point(&mut conn, &[id], || false).unwrap_err();
        assert!(err.starts_with("Nothing was removed"));
        assert_eq!(track_count(&conn), 1);
    }

    #[test]
    fn a_saved_point_lets_the_purge_run() {
        let mut conn = db::open_in_memory().unwrap();
        let id = gone_track(&conn, "/m/a.mp3");
        let summary = purge_with_point(&mut conn, &[id], || true).unwrap();
        assert_eq!(summary.removed, 1);
        assert_eq!(track_count(&conn), 0);
    }

    #[test]
    fn an_empty_id_list_takes_no_point() {
        let mut conn = db::open_in_memory().unwrap();
        gone_track(&conn, "/m/a.mp3");
        let ran = purge_with_point(&mut conn, &[], || panic!("no point for an empty list"));
        assert!(ran.is_ok());
        assert_eq!(track_count(&conn), 1);
    }
}
