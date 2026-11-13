/*
 * The IPC commands for plugins: the registry listing, what the previous run left behind, the base
 * URL a plugin's sandboxed frames load from, and install from a folder or archive. The frame URL stays
 * None until the main webview's frame handler is installed, so nothing mounts a frame that no one would
 * answer. Install work touches the disk, so it runs on a blocking thread, never on the main one.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager, State};

// -- Local Imports --
use super::now_unix;
use crate::plugins::frame_host;
use crate::plugins::install::{self, InboxItem, Inspection};
use crate::plugins::install_error::{ErrorCode, InstallError};
use crate::plugins::session::BootState;
use crate::plugins::stage::Limits;
use crate::plugins::state::{PluginRow, PluginsState};
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

/// Runs an install step on a blocking thread with the app data dir and the plugin state.
async fn run_blocking<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(PathBuf, &PluginsState) -> Result<T, InstallError> + Send + 'static,
) -> Result<T, InstallError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| InstallError::new(ErrorCode::Io, format!("no app data folder: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || job(app_data, &app.state::<AppState>().plugins))
        .await
        .map_err(|_| InstallError::new(ErrorCode::Io, "the install task failed to run"))?
}

/// Stages and checks a plugin folder or `.plistoplugin` file and returns what the review sheet shows,
/// with the token `plugin_install` and `plugin_discard` take.
#[tauri::command]
pub async fn plugin_inspect(path: String, app: AppHandle) -> Result<Inspection, InstallError> {
    run_blocking(app, move |app_data, plugins| {
        install::inspect(&app_data, plugins, &path, Limits::DEFAULT)
    })
    .await
}

/// Installs an inspected plugin, disabled and needing consent. Returns its `plugins_list` row.
#[tauri::command]
pub async fn plugin_install(token: String, app: AppHandle) -> Result<PluginRow, InstallError> {
    run_blocking(app, move |app_data, plugins| {
        install::install(&app_data, plugins, &token, now_unix())
    })
    .await
}

/// Drops an inspected plugin and its staged copy.
#[tauri::command]
pub async fn plugin_discard(token: String, app: AppHandle) -> Result<(), InstallError> {
    run_blocking(app, move |_, plugins| {
        install::discard(plugins, &token);
        Ok(())
    })
    .await
}

/// What waits in the plugins inbox folder.
#[tauri::command]
pub async fn plugin_inbox(app: AppHandle) -> Result<Vec<InboxItem>, InstallError> {
    run_blocking(app, move |app_data, _| install::inbox(&app_data)).await
}
