/*
 * The IPC commands behind the plugin API. Only the main window's host shim calls them, with the id it
 * took from its own frame map; a frame never reaches IPC itself. `plugin_call` always resolves to a
 * reply, so a rejected invoke can only mean the transport failed. Admission runs on the command's
 * thread with no I/O; the method itself may touch the plugin's data folder and runs on a blocking one.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::time::Instant;

use tauri::{AppHandle, Manager, State, Theme, Webview};

// -- Local Imports --
use crate::db;
use crate::plugins::api::error::{ApiError, CallReply};
use crate::plugins::api::state::ApiState;
use crate::plugins::api::{self, Admitted, HostContext};
use crate::plugins::state::EnabledSet;
use crate::state::AppState;

const MAIN_LABEL: &str = "main";

/// The app as a plugin method sees it: the settings table and the main window's OS theme.
struct TauriHost {
    app: AppHandle,
}

impl HostContext for TauriHost {
    fn setting(&self, key: &str) -> Option<String> {
        let state = self.app.try_state::<AppState>()?;
        let conn = state.db.lock().ok()?;
        db::get_setting(&conn, key).ok().flatten()
    }

    fn os_prefers_dark(&self) -> bool {
        self.app
            .get_webview_window(MAIN_LABEL)
            .and_then(|main| main.theme().ok())
            .is_some_and(|theme| matches!(theme, Theme::Dark))
    }
}

/// Admits a call made from the webview `label`: the main window only, and only once its frames can
/// be served.
#[allow(clippy::too_many_arguments)]
fn call_from(
    label: &str,
    frames_ready: bool,
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    method: &str,
    args_len: usize,
    now: Instant,
) -> Result<Admitted, ApiError> {
    if label != MAIN_LABEL {
        return Err(ApiError::denied());
    }
    if !frames_ready {
        return Err(ApiError::unavailable());
    }
    api::admit(enabled, api, id, method, args_len, now)
}

/// Runs one plugin API call for plugin `id`. `args` is the JSON text of an object.
#[tauri::command]
pub async fn plugin_call(
    id: String,
    method: String,
    args: String,
    webview: Webview,
    app: AppHandle,
) -> CallReply {
    let (admitted, api) = {
        let state = app.state::<AppState>();
        let plugins = &state.plugins;
        let admitted = call_from(
            webview.label(),
            state.frames_ready.load(Ordering::SeqCst),
            &plugins.enabled_set(),
            plugins.api(),
            &id,
            &method,
            args.len(),
            Instant::now(),
        );
        (admitted, plugins.api().clone())
    };
    let admitted = match admitted {
        Ok(admitted) => admitted,
        Err(e) => return CallReply::from(Err(e)),
    };
    let Ok(app_data) = app.path().app_data_dir() else {
        return CallReply::from(Err(ApiError::unavailable()));
    };
    let host = TauriHost { app };
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        api::run(&admitted, &args, &app_data, &host, &api)
    })
    .await
    .unwrap_or_else(|_| Err(ApiError::unavailable()));
    CallReply::from(outcome)
}

/// Records the page shown from webview `label`. A page opens only for a serving plugin and closes
/// only if it is the recorded one.
fn page_state_from(label: &str, enabled: &EnabledSet, api: &ApiState, id: &str, open: bool) {
    if label != MAIN_LABEL || (open && !enabled.contains(id)) {
        return;
    }
    api.set_page_open(id, open);
}

/// Reports whether plugin `id`'s page is the one shown in the main window.
#[tauri::command]
pub fn plugin_page_state(id: String, open: bool, webview: Webview, state: State<'_, AppState>) {
    page_state_from(
        webview.label(),
        &state.plugins.enabled_set(),
        state.plugins.api(),
        &id,
        open,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::manifest::Tier;
    use crate::plugins::registry::{Entry, EntryState, Registry};
    use crate::plugins::revalidate::Problems;
    use crate::plugins::session::BootState;
    use crate::plugins::state::PluginsState;

    const ID: &str = "com.example.demo";

    fn serving_one() -> PluginsState {
        let entry = Entry {
            id: ID.to_string(),
            version: "1.0.0".into(),
            tier: Tier::Ui,
            enabled: true,
            granted: Vec::new(),
            installed_at: 1,
            manifest_hash: "h".into(),
            state: EntryState::Ready,
            source_path: None,
            sidebar_collapsed: false,
            ready_enabled: None,
        };
        let registry = Registry {
            entries: vec![entry],
            ..Registry::default()
        };
        PluginsState::new(registry, Problems::new(), BootState::default())
    }

    fn code(label: &str, ready: bool, plugins: &PluginsState) -> Option<ApiCode> {
        call_from(
            label,
            ready,
            &plugins.enabled_set(),
            plugins.api(),
            ID,
            "app.info",
            2,
            Instant::now(),
        )
        .err()
        .map(|e| e.code)
    }

    #[test]
    fn only_the_main_window_may_call() {
        let plugins = serving_one();
        for label in ["tray", "nowplaying", "Main", "main ", ""] {
            assert_eq!(
                code(label, true, &plugins),
                Some(ApiCode::Denied),
                "{label:?}"
            );
        }
        // The label is checked before readiness.
        assert_eq!(code("tray", false, &plugins), Some(ApiCode::Denied));
        assert_eq!(code(MAIN_LABEL, true, &plugins), None);
    }

    #[test]
    fn a_call_before_frames_are_ready_is_unavailable() {
        let plugins = serving_one();
        assert_eq!(
            code(MAIN_LABEL, false, &plugins),
            Some(ApiCode::Unavailable)
        );
        // Refused before admission, so no rate token was spent.
        for _ in 0..10 {
            assert_eq!(code(MAIN_LABEL, true, &plugins), None);
        }
    }

    #[test]
    fn a_page_opens_only_for_a_serving_plugin_from_the_main_window() {
        let plugins = serving_one();
        let enabled = plugins.enabled_set();
        let api = plugins.api();
        page_state_from("tray", &enabled, api, ID, true);
        assert_eq!(api.open_page(), None);
        page_state_from(MAIN_LABEL, &enabled, api, "com.example.off", true);
        assert_eq!(api.open_page(), None);
        page_state_from(MAIN_LABEL, &enabled, api, ID, true);
        assert!(api.is_page_open(ID));
        // Another window cannot close it, nor can another id.
        page_state_from("tray", &enabled, api, ID, false);
        page_state_from(MAIN_LABEL, &enabled, api, "com.example.off", false);
        assert!(api.is_page_open(ID));
        page_state_from(MAIN_LABEL, &enabled, api, ID, false);
        assert_eq!(api.open_page(), None);
    }

    #[test]
    fn a_page_closes_after_its_plugin_stops_serving() {
        let plugins = serving_one();
        let enabled = plugins.enabled_set();
        page_state_from(MAIN_LABEL, &enabled, plugins.api(), ID, true);
        plugins.withdraw(ID);
        page_state_from(MAIN_LABEL, &enabled, plugins.api(), ID, false);
        assert_eq!(plugins.api().open_page(), None);
    }
}
