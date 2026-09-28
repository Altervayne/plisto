/*
 * The IPC command for purging gone tracks: a confirmation-gated DELETE of rows the scan flagged
 * gone (missing_at set), plus the emptied-container sweep. It takes the same scan lock the root
 * commands hold, so a purge never races a scan on the WAL. The DELETE itself guards on
 * `missing_at IS NOT NULL`, so a present track passed by id is safe.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::PurgeSummary;
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

/// Removes the gone tracks in `track_ids` and reports the tally: rows dropped and albums emptied by the
/// cascade. Rejects while a scan runs. Only rows already flagged gone are dropped; a present track passed
/// by id is left in place. No walk. Async so the wait for a preempted background pass never holds the
/// main thread.
#[tauri::command]
pub async fn remove_missing_tracks(
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<PurgeSummary, String> {
    let _lock = acquire_scan_lock(&state, Holder::User)?;
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::remove_missing_tracks(&mut conn, &track_ids).map_err(|e| e.to_string())
}
