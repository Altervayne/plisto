/*
 * The IPC command surface for possible duplicates: the dismissed-pair set and the merge into a keeper
 * with its undo. Detection runs in the frontend; these only persist its outcome. The dismissal writes
 * hold the index lock briefly, while a merge and its undo also take the scan lock as the user, so
 * they never race a scan, and run async so the wait for a preempted background pass stays off the
 * main thread.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use super::organize::with_scan_guard;
use crate::db;
use crate::dto::{DismissedPair, MergeReceipt};
use crate::state::AppState;

/// Marks every pair among the given tracks as not duplicates.
#[tauri::command]
pub fn dismiss_duplicates(track_ids: Vec<i64>, state: State<'_, AppState>) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::dismiss_duplicates(&mut conn, &track_ids, super::now_unix()).map_err(|e| e.to_string())
}

/// Clears every dismissed pair among the given tracks.
#[tauri::command]
pub fn undismiss_duplicates(track_ids: Vec<i64>, state: State<'_, AppState>) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::undismiss_duplicates(&mut conn, &track_ids).map_err(|e| e.to_string())
}

/// Every dismissed pair, lower id first.
#[tauri::command]
pub fn list_duplicate_dismissals(state: State<'_, AppState>) -> Result<Vec<DismissedPair>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::list_duplicate_dismissals(&conn).map_err(|e| e.to_string())
}

/// Folds the duplicates into the keeper and returns the receipt the frontend holds for undo. Rejects
/// while a scan runs, and changes nothing when the keeper, the list or a membership is refused.
#[tauri::command]
pub async fn merge_duplicates(
    keeper_id: i64,
    discard_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<MergeReceipt, String> {
    with_scan_guard(&state, |conn| {
        db::merge_duplicates(conn, keeper_id, &discard_ids, super::now_unix())
            .map_err(|e| e.to_string())
    })
}

/// Undoes a merge from its receipt. Rejects while a scan runs, and changes nothing when the receipt's
/// rows have drifted since.
#[tauri::command]
pub async fn undo_merge_duplicates(
    receipt: MergeReceipt,
    state: State<'_, AppState>,
) -> Result<(), String> {
    with_scan_guard(&state, |conn| {
        db::undo_merge_duplicates(conn, &receipt).map_err(|e| e.to_string())
    })
}
