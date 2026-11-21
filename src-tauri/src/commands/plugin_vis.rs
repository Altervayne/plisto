/*
 * The IPC command for plugin visualizers: the URL a declared kind's frame loads from its plugin's
 * visualizer host. Like the page frame URL, none is handed out until the main webview's frame
 * handler is installed, so nothing mounts a frame that no one would answer.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State};

// -- Local Imports --
use crate::plugins::frame_host::vis_host;
use crate::state::AppState;

/// The URL visualizer `kind` of enabled plugin `id` loads from. Errors when frames are unavailable,
/// the plugin is not installed or not enabled, or it declares no such kind.
#[tauri::command]
pub fn plugin_vis_url(
    id: String,
    kind: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !state.frames_ready.load(Ordering::SeqCst) {
        return Err("plugin frames are unavailable".to_string());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data folder: {e}"))?;
    vis_host::kind_url(&app_data, &id, &kind, &|id| state.plugins.is_enabled(id))
        .map_err(|e| e.to_string())
}
