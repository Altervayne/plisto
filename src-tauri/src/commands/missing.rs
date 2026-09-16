/*
 * The IPC command for purging gone tracks: a confirmation-gated DELETE of rows the scan flagged
 * gone (missing_at set), plus the emptied-container sweep. It takes the same `scan_running` write
 * lock the root commands hold, so a purge never races a scan on the WAL. The DELETE itself guards on
 * `missing_at IS NOT NULL`, so a present track passed by id is safe.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::PurgeSummary;
use crate::state::AppState;

/// Removes the gone tracks in `track_ids` and reports the tally: rows dropped and albums emptied by the
/// cascade. Rejects while a scan runs. Only rows already flagged gone are dropped; a present track passed
/// by id is left in place. No walk.
#[tauri::command]
pub fn remove_missing_tracks(
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<PurgeSummary, String> {
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".to_string());
    }
    let result = (|| -> Result<PurgeSummary, String> {
        let mut conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::remove_missing_tracks(&mut conn, &track_ids).map_err(|e| e.to_string())
    })();
    state.scan_running.store(false, Ordering::SeqCst);
    result
}
