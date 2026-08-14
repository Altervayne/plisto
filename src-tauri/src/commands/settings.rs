/*
 * The IPC command surface for client preferences and the workspace anchor: a small key-value
 * store for prefs, plus a read of the active workspace root. Every access goes through the shared
 * read connection's Mutex - the same single writer the other commands use, no extra connection.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::state::AppState;

/// The first library root's path, or None when the library is empty. The interim single-folder
/// reader until the frontend reads the whole root list.
#[tauri::command]
pub fn workspace_root(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::first_root_path(&conn).map_err(|e| e.to_string())
}

/// The value stored under `key`, or None when it is unset. A client pref falls back to its own
/// default on None.
#[tauri::command]
pub fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::get_setting(&conn, &key).map_err(|e| e.to_string())
}

/// Stores `value` under `key`, replacing any prior value.
#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())
}
