/*
 * The IPC commands for visualizer defaults: one read of every stored default, and a set/clear per
 * album and per track. Each write is a single row, so it takes the plain db lock and no scan lock.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::VisualizerDefaults;
use crate::state::AppState;

/// Reads every stored visualizer default, albums and tracks.
#[tauri::command]
pub fn get_visualizer_defaults(state: State<'_, AppState>) -> Result<VisualizerDefaults, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::list_visualizer_defaults(&conn).map_err(|e| e.to_string())
}

/// Sets one album's default kind, or clears it with `None`. Errors on an unknown album or an
/// invalid kind string.
#[tauri::command]
pub fn set_album_visualizer(
    album_id: i64,
    kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_album_visualizer(&conn, album_id, kind.as_deref())
}

/// Sets one track's default kind, or clears it with `None`. Errors on an unknown track or an
/// invalid kind string.
#[tauri::command]
pub fn set_track_visualizer(
    track_id: i64,
    kind: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_track_visualizer(&conn, track_id, kind.as_deref(), super::now_unix())
}
