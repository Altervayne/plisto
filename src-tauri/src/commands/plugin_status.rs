/*
 * The IPC commands behind the plugin status channel: every supervised plugin's status, and a restart
 * the user asked for. Only the main window may call them. Changes reach that window as
 * `plugins:status` events; this read is for a window that just mounted or saw the runtime change.
 */

// -- Library Imports --
use std::sync::Arc;

use tauri::{AppHandle, Manager, State, Webview};

// -- Local Imports --
use crate::plugins::install_error::{ErrorCode, InstallError};
use crate::plugins::native::status::PluginStatus;
use crate::plugins::native::{NativeHost, StartError};
use crate::plugins::registry::EntryState;
use crate::plugins::state::{PluginsState, Runtime};
use crate::state::AppState;

const MAIN_LABEL: &str = "main";

/// The statuses as seen from `label`: none outside the main window and while plugins do not run.
fn statuses_from(label: &str, runtime: Runtime, host: &NativeHost) -> Vec<PluginStatus> {
    if label != MAIN_LABEL || runtime != Runtime::Running {
        return Vec::new();
    }
    host.statuses()
}

/// Refuses a restart from `label` of a plugin that is not serving, with the code the lifecycle uses.
fn restartable(label: &str, plugins: &PluginsState, id: &str) -> Result<(), InstallError> {
    let not_found = || InstallError::new(ErrorCode::NotFound, format!("{id} is not running"));
    if label != MAIN_LABEL {
        return Err(not_found());
    }
    let entry = plugins
        .snapshot()
        .entry(id)
        .cloned()
        .ok_or_else(not_found)?;
    match entry.state {
        EntryState::Broken => Err(InstallError::new(
            ErrorCode::Broken,
            format!("{id} is broken"),
        )),
        EntryState::Incompatible => Err(InstallError::new(
            ErrorCode::Incompatible,
            format!("{id} needs a newer Plisto"),
        )),
        _ if !plugins.is_enabled(id) => Err(not_found()),
        _ => Ok(()),
    }
}

fn start_error(id: &str, e: StartError) -> InstallError {
    let code = match e {
        StartError::Invalid(_) => ErrorCode::Broken,
        StartError::Changed => ErrorCode::ManifestChanged,
        StartError::Launch(_) => ErrorCode::Io,
        StartError::NotServing | StartError::NotNative | StartError::Exiting => ErrorCode::NotFound,
    };
    InstallError::new(code, format!("{id}: {e}"))
}

/// The status of every supervised plugin; empty while the runtime is not running.
#[tauri::command]
pub fn plugin_statuses(
    webview: Webview,
    state: State<'_, AppState>,
    native: State<'_, Arc<NativeHost>>,
) -> Vec<PluginStatus> {
    statuses_from(webview.label(), state.plugins.runtime(), &native)
}

/// Restarts a serving plugin with a fresh crash count. A native child is stopped, within its grace
/// period, and started again, so this runs on a blocking thread.
#[tauri::command]
pub async fn plugin_restart(
    id: String,
    webview: Webview,
    app: AppHandle,
) -> Result<(), InstallError> {
    let label = webview.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        restartable(&label, &state.plugins, &id)?;
        let native = app.state::<Arc<NativeHost>>();
        native
            .restart(&state.plugins, &id)
            .map_err(|e| start_error(&id, e))
    })
    .await
    .map_err(|_| InstallError::new(ErrorCode::Io, "the restart task failed to run"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::{Capability, Tier};
    use crate::plugins::native::link::RecordingLink;
    use crate::plugins::native::status::HostState;
    use crate::plugins::registry::{Entry, Registry};
    use crate::plugins::revalidate::Problems;
    use crate::plugins::session::BootState;

    const ID: &str = "com.example.demo";

    /// The demo UI plugin in `state`, enabled when `on`.
    fn plugins_with(state: EntryState, on: bool, granted: Vec<Capability>) -> PluginsState {
        let entry = Entry {
            id: ID.to_string(),
            version: "1.0.0".into(),
            tier: Tier::Ui,
            enabled: on,
            granted,
            installed_at: 1,
            manifest_hash: "h".into(),
            state,
            source_path: None,
            sidebar_collapsed: false,
            ready_enabled: None,
            consented_network: Vec::new(),
        };
        let registry = Registry {
            entries: vec![entry],
            ..Registry::default()
        };
        PluginsState::new(registry, Problems::new(), BootState::default())
    }

    fn host() -> NativeHost {
        NativeHost::new(std::env::temp_dir(), Arc::new(RecordingLink::default()))
    }

    #[test]
    fn statuses_go_to_the_main_window_only_and_only_while_running() {
        let plugins = plugins_with(EntryState::Ready, true, vec![Capability::Background]);
        let host = host();
        host.frame_event(&plugins, ID, "live", None);
        assert_eq!(statuses_from(MAIN_LABEL, Runtime::Running, &host).len(), 1);
        for label in ["tray", "nowplaying", "Main", ""] {
            assert!(
                statuses_from(label, Runtime::Running, &host).is_empty(),
                "{label:?}"
            );
        }
        for runtime in [Runtime::Held, Runtime::Safe] {
            assert!(statuses_from(MAIN_LABEL, runtime, &host).is_empty());
        }
    }

    #[test]
    fn a_restart_is_refused_unless_the_plugin_serves() {
        let code = |label: &str, plugins: &PluginsState| {
            restartable(label, plugins, ID).err().map(|e| e.code)
        };
        assert_eq!(
            code(MAIN_LABEL, &PluginsState::empty()),
            Some(ErrorCode::NotFound)
        );
        let serving = plugins_with(EntryState::Ready, true, Vec::new());
        assert_eq!(code(MAIN_LABEL, &serving), None);
        assert_eq!(code("tray", &serving), Some(ErrorCode::NotFound));
        let off = plugins_with(EntryState::Ready, false, Vec::new());
        assert_eq!(code(MAIN_LABEL, &off), Some(ErrorCode::NotFound));
        let broken = plugins_with(EntryState::Broken, true, Vec::new());
        assert_eq!(code(MAIN_LABEL, &broken), Some(ErrorCode::Broken));
        let old = plugins_with(EntryState::Incompatible, true, Vec::new());
        assert_eq!(code(MAIN_LABEL, &old), Some(ErrorCode::Incompatible));
    }

    #[test]
    fn a_restart_of_a_ui_plugin_clears_its_stop_and_asks_for_a_remount() {
        let plugins = plugins_with(EntryState::Ready, true, Vec::new());
        let host = host();
        host.frame_event(&plugins, ID, "crashed", Some("silent"));
        assert_eq!(host.status(ID).unwrap().host, HostState::Stopped);
        host.restart(&plugins, ID).unwrap();
        let status = host.status(ID).unwrap();
        assert_eq!(status.host, HostState::Starting);
        assert!(status.crash.is_none());
    }
}
