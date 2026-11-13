/*
 * The IPC command for plugin frames: the base URL a plugin's sandboxed frames load from. It stays
 * None until the main webview's frame handler is installed, so nothing mounts a frame that no one
 * would answer.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State};

// -- Local Imports --
use crate::plugins::frame_host;
use crate::state::AppState;

/// The frame base URL for an installed plugin, or None when frames are unavailable or the plugin
/// is not installed.
#[tauri::command]
pub fn plugin_frame_url(id: String, app: AppHandle, state: State<'_, AppState>) -> Option<String> {
    if !state.frames_ready.load(Ordering::SeqCst) {
        return None;
    }
    let app_data = app.path().app_data_dir().ok()?;
    frame_host::installed_frame_url(&app_data, &id)
}
