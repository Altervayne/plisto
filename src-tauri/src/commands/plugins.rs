/*
 * The IPC commands for plugins: the registry listing, what the previous run left behind, the base
 * URL a plugin's sandboxed frames load from, install from a folder or archive, and the lifecycle after
 * it. The frame URL stays None until the main webview's frame handler is installed, so nothing mounts a
 * frame that no one would answer. Install and lifecycle work touches the disk, so it runs on a blocking
 * thread, never on the main one. Any call that changed the registry tells the main window with
 * `plugins:changed`; the event carries nothing, the window reads the list again. Every row handed back
 * carries a summary of its installed manifest, read after the state lock is released.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

// -- Local Imports --
use super::now_unix;
use crate::plugins::data_size;
use crate::plugins::frame_host;
use crate::plugins::icon_url;
use crate::plugins::install::{self, InboxItem, Inspection};
use crate::plugins::install_error::{ErrorCode, InstallError};
use crate::plugins::lifecycle::{self, Uninstalled};
use crate::plugins::session::BootState;
use crate::plugins::sidebar_decl::Layout;
use crate::plugins::stage::Limits;
use crate::plugins::state::PluginsState;
use crate::plugins::summary::{self, RowView, UpdatedView};
use crate::plugins::update;
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

/// Every registry entry with its state and, for a plugin that failed a boot check, the reason. Off
/// the main thread: a lifecycle call can hold the state lock while it moves files.
#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> Result<Vec<RowView>, InstallError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| InstallError::new(ErrorCode::Io, format!("no app data folder: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || {
        let rows = app.state::<AppState>().plugins.rows();
        summary::views(&app_data, rows)
    })
    .await
    .map_err(|_| InstallError::new(ErrorCode::Io, "the plugin list task failed to run"))
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

/// `run_blocking` for a step that may change the registry. A refusal can change it too (a plugin
/// found broken is saved as broken), so the event follows the change, not the result.
async fn run_changing<T: Send + 'static>(
    app: AppHandle,
    job: impl FnOnce(PathBuf, &PluginsState) -> Result<T, InstallError> + Send + 'static,
) -> Result<T, InstallError> {
    let before = app.state::<AppState>().plugins.generation();
    let result = run_blocking(app.clone(), job).await;
    if app.state::<AppState>().plugins.generation() != before {
        let _ = app.emit_to("main", "plugins:changed", ());
    }
    result
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
pub async fn plugin_install(token: String, app: AppHandle) -> Result<RowView, InstallError> {
    run_changing(app, move |app_data, plugins| {
        let row = install::install(&app_data, plugins, &token, now_unix())?;
        Ok(summary::view(&app_data, row))
    })
    .await
}

/// Enables a plugin. One that needs consent takes `grants`, exactly its declared capabilities,
/// `manifest_hash`, the hash of the manifest the review sheet showed, and for a native plugin
/// `native_ack`. Returns its `plugins_list` row.
#[tauri::command]
pub async fn plugin_enable(
    id: String,
    grants: Option<Vec<String>>,
    native_ack: Option<bool>,
    manifest_hash: Option<String>,
    app: AppHandle,
) -> Result<RowView, InstallError> {
    run_changing(app, move |app_data, plugins| {
        let row = lifecycle::enable(
            &app_data,
            plugins,
            &id,
            grants.as_deref(),
            native_ack == Some(true),
            manifest_hash.as_deref(),
        )?;
        Ok(summary::view(&app_data, row))
    })
    .await
}

/// Disables and stops a plugin, keeping its consent. Returns its `plugins_list` row.
#[tauri::command]
pub async fn plugin_disable(id: String, app: AppHandle) -> Result<RowView, InstallError> {
    run_changing(app, move |app_data, plugins| {
        let row = lifecycle::disable(&app_data, plugins, &id)?;
        Ok(summary::view(&app_data, row))
    })
    .await
}

/// Replaces an installed plugin with one inspected by `plugin_inspect`.
#[tauri::command]
pub async fn plugin_update(token: String, app: AppHandle) -> Result<UpdatedView, InstallError> {
    run_changing(app, move |app_data, plugins| {
        let done = update::update(&app_data, plugins, &token)?;
        Ok(summary::updated_view(&app_data, done))
    })
    .await
}

/// Removes a plugin's code, and its saved data when `delete_data` is set.
#[tauri::command]
pub async fn plugin_uninstall(
    id: String,
    delete_data: bool,
    app: AppHandle,
) -> Result<Uninstalled, InstallError> {
    run_changing(app, move |app_data, plugins| {
        lifecycle::uninstall(&app_data, plugins, &id, delete_data)
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

/// Records consent for a plugin and leaves it ready and off. Takes the same arguments and refuses
/// the same way as `plugin_enable`. Returns its `plugins_list` row.
#[tauri::command]
pub async fn plugin_approve(
    id: String,
    grants: Option<Vec<String>>,
    native_ack: Option<bool>,
    manifest_hash: Option<String>,
    app: AppHandle,
) -> Result<RowView, InstallError> {
    run_changing(app, move |app_data, plugins| {
        let row = lifecycle::approve(
            &app_data,
            plugins,
            &id,
            grants.as_deref(),
            native_ack == Some(true),
            manifest_hash.as_deref(),
        )?;
        Ok(summary::view(&app_data, row))
    })
    .await
}

/// Saves how a plugin's sidebar items are laid out. Returns its `plugins_list` row.
#[tauri::command]
pub async fn plugin_set_sidebar_layout(
    id: String,
    layout: Layout,
    app: AppHandle,
) -> Result<RowView, InstallError> {
    run_changing(app, move |app_data, plugins| {
        let row = lifecycle::set_sidebar_layout(&app_data, plugins, &id, layout)?;
        Ok(summary::view(&app_data, row))
    })
    .await
}

/// An installed plugin's icon as a `data:` URL; None when it has none, it cannot be read or the id
/// is not valid.
#[tauri::command]
pub async fn plugin_icon(id: String, app: AppHandle) -> Option<String> {
    run_blocking(app, move |app_data, _| {
        Ok(icon_url::installed_icon(&app_data, &id))
    })
    .await
    .ok()
    .flatten()
}

/// A staged plugin's icon as a `data:` URL; None when it has none, it cannot be read or the token is
/// unknown. The token stays usable for `plugin_install`, `plugin_update` and `plugin_discard`.
#[tauri::command]
pub async fn plugin_staged_icon(token: String, app: AppHandle) -> Option<String> {
    run_blocking(app, move |_, plugins| {
        Ok(icon_url::staged_icon(plugins, &token))
    })
    .await
    .ok()
    .flatten()
}

/// The plugins inbox folder, created if missing.
#[tauri::command]
pub async fn plugin_inbox_path(app: AppHandle) -> Result<String, InstallError> {
    run_blocking(app, move |app_data, _| install::inbox_path(&app_data)).await
}

/// Bytes of saved data a plugin holds; 0 when it has none.
#[tauri::command]
pub async fn plugin_data_size(id: String, app: AppHandle) -> Result<u64, InstallError> {
    run_blocking(app, move |app_data, _| data_size::data_size(&app_data, &id)).await
}
