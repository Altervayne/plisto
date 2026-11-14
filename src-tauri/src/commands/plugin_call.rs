/*
 * The IPC commands behind the plugin API. Only the main window's host shim calls them, with the id it
 * took from its own frame map; a frame never reaches IPC itself. `plugin_call` always resolves to a
 * reply, so a rejected invoke can only mean the transport failed. Admission runs on the command's
 * thread with no I/O; the method itself may touch the plugin's data folder and runs on a blocking one,
 * and a job it hands back, such as a network request, is awaited on the async runtime.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Instant;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Theme, Webview};

// -- Local Imports --
use crate::db;
use crate::plugins::api::error::{ApiError, CallReply};
use crate::plugins::api::host_event::{HostEvent, EVENT_SIDEBAR, EVENT_UI};
use crate::plugins::api::state::ApiState;
use crate::plugins::api::{self, Admitted, HostContext, Started};
use crate::plugins::state::EnabledSet;
use crate::state::AppState;

const MAIN_LABEL: &str = "main";

/// The app as a plugin method sees it: the settings table, the main window's OS theme and whether it
/// is shown, events to it, and the managed state the library and playback methods read.
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

    fn emit(&self, event: HostEvent) {
        let _ = match event {
            HostEvent::Ui(event) => self.app.emit_to(MAIN_LABEL, EVENT_UI, event),
            HostEvent::Sidebar(event) => self.app.emit_to(MAIN_LABEL, EVENT_SIDEBAR, event),
        };
    }

    fn main_window_shown(&self) -> bool {
        self.app.get_webview_window(MAIN_LABEL).is_some_and(|main| {
            matches!(main.is_visible(), Ok(true)) && matches!(main.is_minimized(), Ok(false))
        })
    }

    fn app_state(&self) -> Option<&AppState> {
        self.app.try_state::<AppState>().map(|state| state.inner())
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
    CallReply::from(complete(admitted, args, app_data, host, api).await)
}

/// Runs an admitted call's handler on a blocking thread, then awaits a job it hands back. `admitted`
/// lives until the job resolves, so the call keeps its in-flight slot that long.
async fn complete<H: HostContext + 'static>(
    admitted: Admitted,
    args: String,
    app_data: PathBuf,
    host: H,
    api: ApiState,
) -> Result<Value, ApiError> {
    let started = tauri::async_runtime::spawn_blocking(move || {
        let started = api::start(&admitted, &args, &app_data, &host, &api);
        (started, admitted)
    })
    .await;
    match started {
        Ok((Started::Done(result), _)) => result,
        Ok((Started::Later(job), admitted)) => {
            let result = job.await;
            drop(admitted);
            result
        }
        Err(_) => Err(ApiError::unavailable()),
    }
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
        let result = tauri::async_runtime::block_on(complete(
            admitted,
            "{}".into(),
            PathBuf::from("unused"),
            api::FakeHost::default(),
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
    fn a_page_closes_after_its_plugin_stops_serving() {
        let plugins = serving_one();
        let enabled = plugins.enabled_set();
        page_state_from(MAIN_LABEL, &enabled, plugins.api(), ID, true);
        let _withdrawn = plugins.withdraw(ID);
        page_state_from(MAIN_LABEL, &enabled, plugins.api(), ID, false);
        assert_eq!(plugins.api().open_page(), None);
    }
}
