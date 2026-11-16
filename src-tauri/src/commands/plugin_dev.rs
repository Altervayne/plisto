/*
 * The IPC commands for developer mode: the switch, reload from source and the log tail. Each is a thin
 * wrapper over `plugins::dev_mode` and `plugins::log_tail`; a change that reaches the registry tells the
 * main window through `plugins:changed`, as every other plugin command does. Every command here answers
 * the main window only, reload and the log tail only while developer mode is on, and the log tail takes
 * an id, never a path.
 */

// -- Library Imports --
use tauri::{AppHandle, State, Webview};

// -- Local Imports --
use super::plugins::{run_blocking, run_changing, MAIN_LABEL};
use crate::plugins::dev_mode;
use crate::plugins::install_error::{ErrorCode, InstallError};
use crate::plugins::log_tail::{self, LogTail};
use crate::plugins::stage::Limits;
use crate::plugins::summary::{self, UpdatedView};
use crate::state::AppState;

/// Whether developer mode is on.
#[tauri::command]
pub fn plugins_dev_mode(
    webview: Webview,
    state: State<'_, AppState>,
) -> Result<bool, InstallError> {
    main_only(webview.label())?;
    Ok(dev_mode::is_on(&state.plugins))
}

/// Turns developer mode on or off. Returns the saved value. Main window only.
#[tauri::command]
pub async fn plugin_set_dev_mode(
    on: bool,
    webview: Webview,
    app: AppHandle,
) -> Result<bool, InstallError> {
    main_only(webview.label())?;
    run_changing(app, move |app_data, plugins| {
        dev_mode::set(&app_data, plugins, on)
    })
    .await
}

/// Re-installs a plugin from the source it was installed from, as an update. Returns the updated row.
/// Main window only, and only while developer mode is on.
#[tauri::command]
pub async fn plugin_reload(
    id: String,
    webview: Webview,
    app: AppHandle,
) -> Result<UpdatedView, InstallError> {
    main_only(webview.label())?;
    run_changing(app, move |app_data, plugins| {
        let done = dev_mode::reload(&app_data, plugins, &id, Limits::DEFAULT)?;
        Ok(summary::updated_view(&app_data, done))
    })
    .await
}

/// Refuses a window that is not the main one.
fn main_only(label: &str) -> Result<(), InstallError> {
    if label == MAIN_LABEL {
        return Ok(());
    }
    Err(InstallError::new(
        ErrorCode::NotFound,
        "developer mode commands are only available to the main window",
    ))
}

/// The last lines of a plugin's `plugin.log` and, for a native plugin, its `stderr.log`. Main window
/// only, and only while developer mode is on.
#[tauri::command]
pub async fn plugin_log_tail(
    id: String,
    webview: Webview,
    app: AppHandle,
) -> Result<LogTail, InstallError> {
    main_only(webview.label())?;
    run_blocking(app, move |app_data, plugins| {
        dev_mode::require_on(plugins)?;
        log_tail::log_tail(&app_data, plugins, &id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_main_window_may_read_a_log() {
        assert!(main_only(MAIN_LABEL).is_ok());
        for label in ["tray", "nowplaying", "Main", "main ", ""] {
            assert_eq!(
                main_only(label).unwrap_err().code,
                ErrorCode::NotFound,
                "{label:?}"
            );
        }
    }
}
