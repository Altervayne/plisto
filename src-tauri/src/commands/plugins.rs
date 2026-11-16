/*
 * The IPC commands for plugins: the registry listing, the runtime and the answer to a held boot, the
 * base URL a plugin's sandboxed frames load from, install from a folder or archive, and the lifecycle
 * after it. The frame URL stays None until the main webview's frame handler is installed, so nothing mounts a
 * frame that no one would answer. Install and lifecycle work touches the disk, so it runs on a blocking
 * thread, never on the main one. Any call that changed the registry tells the main window with
 * `plugins:changed`; the event carries nothing, the window reads the list again. Every row handed back
 * carries a summary of its installed manifest, read after the state lock is released.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State, Webview};

// -- Local Imports --
use super::now_unix;
use crate::plugins::data_size;
use crate::plugins::frame_host;
use crate::plugins::icon_url;
use crate::plugins::install::{self, InboxItem, Inspection};
use crate::plugins::install_error::{ErrorCode, InstallError};
use crate::plugins::lifecycle::{self, Uninstalled};
use crate::plugins::session;
use crate::plugins::stage::Limits;
use crate::plugins::state::{BootView, PluginsState, Runtime};
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

pub(super) const MAIN_LABEL: &str = "main";

/// Whether plugins run this session, with what the previous run left behind.
#[tauri::command]
pub fn plugins_boot_state(state: State<'_, AppState>) -> BootView {
    state.plugins.boot_view()
}

/// Answers a held boot from webview `label`. None when the label is not the main window or the
/// runtime was not held.
fn resolve_from(label: &str, plugins: &PluginsState, safe: bool) -> Option<BootView> {
    if label != MAIN_LABEL {
        return None;
    }
    plugins.resolve_held(safe)
}

/// Answers the held boot: `safe` keeps every plugin off for this session, otherwise they run. Any
/// other window, or a runtime that is not held, gets the current view and changes nothing.
#[tauri::command]
pub async fn plugins_resolve_boot(safe: bool, webview: Webview, app: AppHandle) -> BootView {
    let state = app.state::<AppState>();
    let Some(view) = resolve_from(webview.label(), &state.plugins, safe) else {
        return state.plugins.boot_view();
    };
    // A safe answer is announced by the runtime's safe hook, which also stops what runs.
    if view.runtime == Runtime::Running {
        let _ = app.emit_to(MAIN_LABEL, "plugins:runtime", view);
        let _ = app.emit_to(MAIN_LABEL, "plugins:changed", ());
        #[cfg(windows)]
        start_serving(app.clone());
    }
    view
}

/// The one relaunch path. Writes the safe-mode flag first, so a refused write leaves the app running
/// as it was, then runs `teardown`, removes the session marker here (the teardown leaves it) so the
/// next launch reads a clean exit, and calls `restart`.
fn relaunch(
    app_data: &std::path::Path,
    safe: bool,
    teardown: impl FnOnce(),
    restart: impl FnOnce(),
) -> Result<(), InstallError> {
    session::set_safe_mode(app_data, safe)
        .map_err(|e| InstallError::new(ErrorCode::Io, format!("cannot write the safe-mode flag: {e}")))?;
    teardown();
    session::clear(app_data);
    restart();
    Ok(())
}

/// Restarts Plisto: with no plugins for the next session when `safe`, normally otherwise. Every
/// plugin process is stopped first. Main window only.
#[tauri::command]
pub async fn plugins_restart(safe: bool, webview: Webview, app: AppHandle) -> Result<(), InstallError> {
    if webview.label() != MAIN_LABEL {
        return Ok(());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| InstallError::new(ErrorCode::Io, format!("no app data folder: {e}")))?;
    tauri::async_runtime::spawn_blocking(move || {
        relaunch(
            &app_data,
            safe,
            || crate::tear_down(&app),
            || app.restart(),
        )
    })
    .await
    .map_err(|_| InstallError::new(ErrorCode::Io, "the restart task failed to run"))?
}

/// Stops every plugin process before an update replaces the binary. Main window only.
#[tauri::command]
pub async fn plugins_shutdown_for_update(webview: Webview, app: AppHandle) -> Result<(), InstallError> {
    if webview.label() != MAIN_LABEL {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || crate::stop_plugins(&app, false))
        .await
        .map_err(|_| InstallError::new(ErrorCode::Io, "the plugin shutdown task failed to run"))
}

/// Lets plugins start again after an update that did not install, and starts them when plugins run
/// this session. Main window only.
#[tauri::command]
pub fn plugins_resume_after_update(webview: Webview, app: AppHandle) {
    if webview.label() != MAIN_LABEL {
        return;
    }
    #[cfg(windows)]
    app.state::<std::sync::Arc<crate::plugins::native::NativeHost>>()
        .release_starts();
    app.state::<AppState>().streams().release();
    if app.state::<AppState>().plugins.runtime() == Runtime::Running {
        #[cfg(windows)]
        start_serving(app.clone());
    }
}

/// Starts every serving plugin on a thread of its own, as the boot does, since each native start
/// reads its folder.
#[cfg(windows)]
fn start_serving(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("plugin-boot".into())
        .spawn(move || {
            let native = app.state::<std::sync::Arc<crate::plugins::native::NativeHost>>();
            native.start_serving(&app.state::<AppState>().plugins);
        });
}

/// Runs an install step on a blocking thread with the app data dir and the plugin state.
pub(super) async fn run_blocking<T: Send + 'static>(
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
pub(super) async fn run_changing<T: Send + 'static>(
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

/// Installs an inspected plugin, disabled and needing consent. With `clear_data`, saved data left
/// under the id is deleted first. Returns its `plugins_list` row.
#[tauri::command]
pub async fn plugin_install(
    token: String,
    clear_data: Option<bool>,
    app: AppHandle,
) -> Result<RowView, InstallError> {
    let clear_data = clear_data.unwrap_or(false);
    run_changing(app, move |app_data, plugins| {
        let row = install::install_new(&app_data, plugins, &token, now_unix(), clear_data)?;
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

/// Saves whether a plugin's sidebar group is collapsed. Returns its `plugins_list` row.
#[tauri::command]
pub async fn plugin_set_sidebar_collapsed(
    id: String,
    collapsed: bool,
    app: AppHandle,
) -> Result<RowView, InstallError> {
    run_changing(app, move |app_data, plugins| {
        let row = lifecycle::set_sidebar_collapsed(&app_data, plugins, &id, collapsed)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::Tier;
    use crate::plugins::registry::{Entry, EntryState, Registry};
    use crate::plugins::revalidate::Problems;
    use crate::plugins::session::BootState;

    const ID: &str = "com.example.demo";

    /// An enabled native plugin after an unclean exit: the runtime is held.
    fn held() -> PluginsState {
        let entry = Entry {
            id: ID.to_string(),
            version: "1.0.0".into(),
            tier: Tier::Native,
            enabled: true,
            granted: Vec::new(),
            installed_at: 1,
            manifest_hash: "h".into(),
            state: EntryState::Ready,
            source_path: None,
            sidebar_collapsed: false,
            ready_enabled: None,
            consented_network: Vec::new(),
        };
        let registry = Registry {
            entries: vec![entry],
            ..Registry::default()
        };
        let boot = BootState {
            safe_mode: false,
            unclean: true,
        };
        PluginsState::new(registry, Problems::new(), boot)
    }

    #[test]
    fn only_the_main_window_may_resolve_the_boot() {
        let plugins = held();
        for label in ["tray", "nowplaying", "Main", "main ", ""] {
            for safe in [false, true] {
                assert_eq!(resolve_from(label, &plugins, safe), None, "{label:?}");
            }
        }
        assert_eq!(plugins.runtime(), Runtime::Held);
        assert!(!plugins.is_enabled(ID));

        let view = resolve_from(MAIN_LABEL, &plugins, false).unwrap();
        assert_eq!(view.runtime, Runtime::Running);
        assert!(view.unclean && !view.safe_flag);
        assert!(plugins.is_enabled(ID));
        // Answered once: the main window gets nothing to act on either.
        assert_eq!(resolve_from(MAIN_LABEL, &plugins, true), None);
        assert_eq!(plugins.runtime(), Runtime::Running);
    }

    #[test]
    fn the_main_window_can_choose_safe_mode() {
        let plugins = held();
        let view = resolve_from(MAIN_LABEL, &plugins, true).unwrap();
        assert_eq!(view.runtime, Runtime::Safe);
        assert!(!plugins.is_enabled(ID));
        assert_eq!(resolve_from(MAIN_LABEL, &plugins, false), None);
        assert!(!plugins.is_enabled(ID));
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plisto-relaunch-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_safe_relaunch_writes_the_flag_and_removes_the_marker() {
        let dir = scratch("safe");
        session::stamp(&dir, "2.7.0", 1).unwrap();
        let order = std::cell::RefCell::new(Vec::new());
        relaunch(
            &dir,
            true,
            || order.borrow_mut().push("teardown"),
            || order.borrow_mut().push("restart"),
        )
        .unwrap();
        assert_eq!(*order.borrow(), ["teardown", "restart"]);
        let boot = session::boot_state(&dir, "2.7.0");
        assert!(boot.safe_mode && !boot.unclean);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_normal_relaunch_clears_the_flag_and_removes_the_marker() {
        let dir = scratch("normal");
        session::set_safe_mode(&dir, true).unwrap();
        session::stamp(&dir, "2.7.0", 1).unwrap();
        let mut restarted = false;
        relaunch(&dir, false, || {}, || restarted = true).unwrap();
        assert!(restarted);
        assert_eq!(session::boot_state(&dir, "2.7.0"), BootState::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_relaunch_that_cannot_write_the_flag_stops_nothing() {
        let dir = scratch("refused");
        // A file where the state folder belongs.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(crate::plugins::paths::state_dir(&dir), b"x").unwrap();
        let ran = std::cell::Cell::new(false);
        assert!(relaunch(&dir, true, || ran.set(true), || ran.set(true)).is_err());
        assert!(!ran.get());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
