/*
 * The IPC commands behind the plugin API. Only the main window's host shim calls them, with the id it
 * took from its own frame map; a frame never reaches IPC itself. `plugin_call` always resolves to a
 * reply, so a rejected invoke can only mean the transport failed. Admission runs on the command's
 * thread with no I/O; the method itself may touch the plugin's data folder and runs on a blocking one,
 * and a job it hands back, such as a network request, is awaited on the async runtime.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Manager, Webview};

// -- Local Imports --
use crate::plugins::api::error::{ApiError, CallReply};
use crate::plugins::api::state::ApiState;
use crate::plugins::api::tauri_host::TauriHost;
use crate::plugins::api::{self, Admitted};
#[cfg(windows)]
use crate::plugins::native::NativeHost;
use crate::plugins::state::EnabledSet;
use crate::state::AppState;

const MAIN_LABEL: &str = "main";

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
    let host = Arc::new(TauriHost::new(app));
    CallReply::from(api::complete(admitted, args, app_data, host, api).await)
}

/// Records the page shown from webview `label`. A page opens only for a serving plugin and closes
/// only if it is the recorded one. Returns the pages that changed, each with whether it is now open.
fn page_state_from(
    label: &str,
    enabled: &EnabledSet,
    api: &ApiState,
    id: &str,
    open: bool,
) -> Vec<(String, bool)> {
    if label != MAIN_LABEL || (open && !enabled.contains(id)) {
        return Vec::new();
    }
    let before = api.open_page();
    api.set_page_open(id, open);
    let after = api.open_page();
    if before == after {
        return Vec::new();
    }
    let closed = before.map(|id| (id, false));
    let opened = after.map(|id| (id, true));
    closed.into_iter().chain(opened).collect()
}

/// Reports whether plugin `id`'s page is the one shown in the main window. A native plugin's child is
/// told when its page is shown or hidden, and a UI plugin's page frame reads as starting until it
/// reports live.
#[tauri::command]
pub fn plugin_page_state(id: String, open: bool, webview: Webview, app: AppHandle) {
    let state = app.state::<AppState>();
    let changed = page_state_from(
        webview.label(),
        &state.plugins.enabled_set(),
        state.plugins.api(),
        &id,
        open,
    );
    #[cfg(windows)]
    if let Some(native) = app.try_state::<Arc<NativeHost>>() {
        for (id, open) in changed {
            native.page_changed(&state.plugins, &id, open);
        }
    }
    #[cfg(not(windows))]
    let _ = changed;
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
    use std::path::PathBuf;

    const ID: &str = "com.example.demo";
    const OTHER: &str = "com.example.other";

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
            consented_network: Vec::new(),
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
    fn a_later_job_resolves_on_the_async_runtime_holding_its_slot() {
        let plugins = serving_one();
        let api = plugins.api().clone();
        let admitted = api::admit_in(
            api::LATER_TABLE,
            &plugins.enabled_set(),
            &api,
            ID,
            "test.later",
            2,
            Instant::now(),
        )
        .unwrap();
        let result = tauri::async_runtime::block_on(api::complete(
            admitted,
            "{}".into(),
            PathBuf::from("unused"),
            Arc::new(api::FakeHost::default()),
            api.clone(),
        ));
        assert_eq!(result, Ok(serde_json::json!({ "id": ID, "in_flight": 1 })));
        // The slot was given back once the job resolved: 16 more calls fit.
        let held: Vec<Admitted> = (0..16)
            .map(|_| {
                api::admit(
                    &plugins.enabled_set(),
                    &api,
                    ID,
                    "log.write",
                    2,
                    Instant::now(),
                )
                .unwrap()
            })
            .collect();
        assert_eq!(held.len(), 16);
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
    fn only_a_real_change_of_the_open_page_is_reported() {
        let mut registry = serving_one().snapshot();
        let mut other = registry.entries[0].clone();
        other.id = OTHER.to_string();
        registry.entries.push(other);
        let plugins = PluginsState::new(registry, Problems::new(), BootState::default());
        let enabled = plugins.enabled_set();
        let api = plugins.api();
        let report = |id: &str, open: bool| page_state_from(MAIN_LABEL, &enabled, api, id, open);
        assert_eq!(report(ID, true), [(ID.to_string(), true)]);
        assert!(report(ID, true).is_empty());
        // Another page taking the slot closes the first.
        assert_eq!(
            report(OTHER, true),
            [(ID.to_string(), false), (OTHER.to_string(), true)]
        );
        assert!(report(ID, false).is_empty());
        assert_eq!(report(OTHER, false), [(OTHER.to_string(), false)]);
        assert!(page_state_from("tray", &enabled, api, ID, true).is_empty());
    }

    #[test]
    fn a_page_closes_after_its_plugin_stops_serving() {
        let plugins = serving_one();
        let enabled = plugins.enabled_set();
        page_state_from(MAIN_LABEL, &enabled, plugins.api(), ID, true);
        let _withdrawn = plugins.withdraw(ID);
        page_state_from(MAIN_LABEL, &enabled, plugins.api(), ID, false);
        assert_eq!(plugins.api().open_page(), None);
    }
}
