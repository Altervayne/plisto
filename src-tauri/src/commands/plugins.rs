/*
 * The IPC commands for plugins: the registry listing, what the previous run left behind, and the base
 * URL a plugin's sandboxed frames load from. The frame URL stays None until the main webview's frame
 * handler is installed, so nothing mounts a frame that no one would answer.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State};

// -- Local Imports --
use crate::plugins::frame_host;
use crate::plugins::session::BootState;
use crate::plugins::state::PluginRow;
use crate::state::AppState;

/// The frame base URL for an enabled plugin, or None when frames are unavailable or the plugin is
/// not installed or not enabled.
#[tauri::command]
pub fn plugin_frame_url(id: String, app: AppHandle, state: State<'_, AppState>) -> Option<String> {
    if !state.frames_ready.load(Ordering::SeqCst) {
        return None;
    }
    let app_data = app.path().app_data_dir().ok()?;
    frame_host::installed_frame_url(&app_data, &id, &|id| state.plugins.is_enabled(id))
}

/// Every registry entry with its state and, for a plugin that failed a boot check, the reason.
#[tauri::command]
pub fn plugins_list(state: State<'_, AppState>) -> Vec<PluginRow> {
    state.plugins.rows()
}

/// Whether safe mode is on and whether the previous run ended uncleanly.
#[tauri::command]
pub fn plugins_boot_state(state: State<'_, AppState>) -> BootState {
    state.plugins.boot_state()
}
