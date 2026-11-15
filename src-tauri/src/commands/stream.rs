/*
 * The plugin stream as the windows read it: the seated stream's display state, for a window that
 * mounts after the last `player:stream` event.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use crate::plugins::api::stream::StreamNow;
use crate::state::AppState;

/// The seated stream's display state, or None when no stream is seated.
#[tauri::command]
pub fn get_stream_now(state: State<'_, AppState>) -> Option<StreamNow> {
    state.streams().now()
}
