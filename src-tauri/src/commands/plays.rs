/*
 * The play-history command surface: the reset utility and the two discovery reads the Home surfaces
 * lean on. Each holds the index lock briefly and returns ordered track ids; the frontend already holds
 * every TrackRow, so it hydrates from its store rather than re-projecting rows here.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::HistoryRow;
use crate::state::AppState;

/// Clears play history: a track id wipes just that track's plays, None wipes the whole log. A discrete
/// user action, so it takes the index lock and reports a plain error string.
#[tauri::command]
pub fn reset_play_history(track_id: Option<i64>, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::reset_plays(&conn, track_id).map_err(|e| e.to_string())
}

/// The most recently played track ids, most recent first, one per track. `limit` caps the list.
#[tauri::command]
pub fn get_recently_played(limit: i64, state: State<'_, AppState>) -> Result<Vec<i64>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::get_recently_played(&conn, limit).map_err(|e| e.to_string())
}

/// The most played track ids by weighted score, highest first. `since` (unix seconds) windows the
/// count to recent plays, or None for all-time.
#[tauri::command]
pub fn get_most_played(
    limit: i64,
    since: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<i64>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::get_most_played(&conn, limit, since).map_err(|e| e.to_string())
}

/// The deduped last-play rows for the History surface, newest last-play first. `limit` caps the
/// list, or None for the whole history.
#[tauri::command]
pub fn get_recently_played_rows(
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryRow>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::get_recently_played_rows(&conn, limit).map_err(|e| e.to_string())
}

/// The raw play-count ranking rows for the History surface, most plays first. `limit` caps the
/// list, or None for the whole history.
#[tauri::command]
pub fn get_most_played_rows(
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryRow>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::get_most_played_rows(&conn, limit).map_err(|e| e.to_string())
}
