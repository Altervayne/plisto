/*
 * The IPC commands behind plugin UI surfaces: answering a toast or prompt, re-reading what is open and
 * the live sidebar state, reporting a sidebar click, and telling Rust a plugin's frame is gone. Only the
 * main window may call them. A click here is the only place a gesture is minted from user input, so a
 * plugin frame must never reach these commands itself.
 */

// -- Library Imports --
use std::path::Path;
use std::time::Instant;

use tauri::{AppHandle, Manager, State, Webview};

// -- Local Imports --
use crate::plugins::api::host_event::UiEvent;
use crate::plugins::api::sidebar::{check_input, SidebarInputReply, SidebarSnapshot};
use crate::plugins::api::state::ApiState;
use crate::plugins::api::ui_state::UiAnswer;
use crate::plugins::paths::validate_id;
use crate::plugins::state::{EnabledSet, Runtime};
use crate::state::AppState;

const MAIN_LABEL: &str = "main";

/// The id of the plugin that owns the open request, when it is still open.
fn owner_of(api: &ApiState, request_id: &str) -> Option<String> {
    api.ui()
        .pending_events()
        .into_iter()
        .find(|event| event.request_id == request_id)
        .map(|event| event.id)
}

/// Resolves the open request from webview `label`. `false` when the label is not the main window or the
/// request is not open or is of the other kind. A toast action earns a gesture only while its plugin
/// serves.
fn answer_from(
    label: &str,
    api: &ApiState,
    enabled: &EnabledSet,
    request_id: &str,
    answer: UiAnswer,
    now: Instant,
) -> bool {
    if label != MAIN_LABEL {
        return false;
    }
    let serving = owner_of(api, request_id).is_some_and(|id| enabled.contains(&id));
    api.ui().answer(request_id, answer, serving, now)
}

/// The open toasts and prompts as seen from `label`; empty outside the main window and while plugins
/// do not run.
fn pending_from(label: &str, runtime: Runtime, api: &ApiState) -> Vec<UiEvent> {
    if label != MAIN_LABEL || runtime != Runtime::Running {
        return Vec::new();
    }
    api.ui().pending_events()
}

/// The live sidebar state of every serving plugin as seen from `label`; empty outside the main window
/// and while plugins do not run.
fn sidebar_state_from(
    label: &str,
    runtime: Runtime,
    api: &ApiState,
    enabled: &EnabledSet,
) -> Vec<SidebarSnapshot> {
    if label != MAIN_LABEL || runtime != Runtime::Running {
        return Vec::new();
    }
    api.sidebar().snapshot(enabled)
}

/// Decides a click reported from `label`. Refused outside the main window and while plugins do not
/// run; the rest is `check_input`.
#[allow(clippy::too_many_arguments)]
fn sidebar_input_from(
    label: &str,
    runtime: Runtime,
    api: &ApiState,
    enabled: &EnabledSet,
    app_data: &Path,
    id: &str,
    item_id: &str,
    value: Option<bool>,
    now: Instant,
) -> SidebarInputReply {
    if label != MAIN_LABEL || runtime != Runtime::Running {
        return SidebarInputReply {
            accepted: false,
            frame: None,
        };
    }
    check_input(api, enabled, app_data, id, item_id, value, now)
}

/// Frees what plugin `id` holds once its frame is gone. Both kinds end its open requests and drop its
/// gestures; a crash also drops its sidebar state. Any other label, kind or id has no effect.
fn frame_event_from(label: &str, api: &ApiState, id: &str, kind: &str) {
    if label != MAIN_LABEL || validate_id(id).is_err() {
        return;
    }
    match kind {
        "detached" => {
            api.ui().release(id);
            api.ui().drop_gestures(id);
        }
        "crashed" => {
            api.ui().release(id);
            api.ui().drop_gestures(id);
            api.sidebar().forget(id);
        }
        _ => {}
    }
}

/// Answers the open toast or prompt `request_id`. `true` when it resolved one.
#[tauri::command]
pub fn plugin_ui_answer(
    request_id: String,
    answer: UiAnswer,
    webview: Webview,
    state: State<'_, AppState>,
) -> bool {
    answer_from(
        webview.label(),
        state.plugins.api(),
        &state.plugins.enabled_set(),
        &request_id,
        answer,
        Instant::now(),
    )
}

/// The open toasts and prompts, in arrival order.
#[tauri::command]
pub fn plugin_ui_pending(webview: Webview, state: State<'_, AppState>) -> Vec<UiEvent> {
    pending_from(
        webview.label(),
        state.plugins.runtime(),
        state.plugins.api(),
    )
}

/// The live sidebar state of every serving plugin.
#[tauri::command]
pub fn plugin_sidebar_state(webview: Webview, state: State<'_, AppState>) -> Vec<SidebarSnapshot> {
    sidebar_state_from(
        webview.label(),
        state.plugins.runtime(),
        state.plugins.api(),
        &state.plugins.enabled_set(),
    )
}

/// Reports a click on a toggle (`value` set) or an action (`value` none). Runs on a blocking thread
/// because the plugin's manifest may be read.
#[tauri::command]
pub async fn plugin_sidebar_input(
    id: String,
    item_id: String,
    value: Option<bool>,
    webview: Webview,
    app: AppHandle,
) -> SidebarInputReply {
    let refused = SidebarInputReply {
        accepted: false,
        frame: None,
    };
    let label = webview.label().to_string();
    let (runtime, enabled, api) = {
        let state = app.state::<AppState>();
        (
            state.plugins.runtime(),
            state.plugins.enabled_set(),
            state.plugins.api().clone(),
        )
    };
    let Ok(app_data) = app.path().app_data_dir() else {
        return refused;
    };
    tauri::async_runtime::spawn_blocking(move || {
        sidebar_input_from(
            &label,
            runtime,
            &api,
            &enabled,
            &app_data,
            &id,
            &item_id,
            value,
            Instant::now(),
        )
    })
    .await
    .unwrap_or(refused)
}

/// Reports that plugin `id`'s last frame went away: `kind` is `"detached"` or `"crashed"`.
#[tauri::command]
pub fn plugin_frame_event(id: String, kind: String, webview: Webview, state: State<'_, AppState>) {
    frame_event_from(webview.label(), state.plugins.api(), &id, &kind);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::{dispatch, FakeHost};
    use crate::plugins::manifest::{Capability, Tier};
    use crate::plugins::paths::plugin_dir;
    use crate::plugins::registry::{Entry, EntryState, Registry};
    use crate::plugins::revalidate::Problems;
    use crate::plugins::session::BootState;
    use crate::plugins::stage::Temp;
    use crate::plugins::state::PluginsState;
    use serde_json::{json, Value};
    use std::fs;
    use std::sync::Arc;
    use std::thread::JoinHandle;
    use std::time::Duration;

    const ID: &str = "com.example.demo";

    fn plugins_of(tier: Tier) -> PluginsState {
        let entry = Entry {
            id: ID.to_string(),
            version: "1.0.0".into(),
            tier,
            enabled: true,
            granted: vec![
                Capability::UiToast,
                Capability::UiChips,
                Capability::UiSidebar,
            ],
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

    /// An app data folder holding the demo plugin's manifest with a toggle and an action.
    fn data_with_sidebar() -> Temp {
        let temp = Temp::new("plugin-ui");
        let dir = plugin_dir(&temp.0, ID);
        fs::create_dir_all(&dir).unwrap();
        let manifest = json!({
            "manifest_version": 1, "id": ID, "name": "Demo", "version": "1.0.0", "tier": "ui",
            "entry": "index.html", "min_plisto": "1.0.0", "author": "A",
            "capabilities": ["background", "ui.chips", "ui.sidebar"],
            "sidebar": { "layout": "section", "items": [
                { "id": "tg", "type": "toggle", "label": "Watch" },
                { "id": "go", "type": "action", "label": "Run" } ] },
        });
        fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
        temp
    }

    /// Starts a toast call from the plugin on its own thread and returns once it is open.
    fn open_toast(
        plugins: &PluginsState,
        host: &Arc<FakeHost>,
        args: &str,
    ) -> JoinHandle<Result<Value, crate::plugins::api::error::ApiError>> {
        let before = plugins.api().ui().pending_events().len();
        let (enabled, api) = (plugins.enabled_set(), plugins.api().clone());
        let (host, args) = (host.clone(), args.to_string());
        let handle = std::thread::spawn(move || {
            dispatch(
                &enabled,
                &api,
                ID,
                "ui.toast",
                &args,
                Path::new("unused"),
                &*host,
                Instant::now(),
            )
        });
        let started = Instant::now();
        while plugins.api().ui().pending_events().len() <= before {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "toast never opened"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        handle
    }

    fn open_request(plugins: &PluginsState) -> String {
        plugins.api().ui().pending_events()[0].request_id.clone()
    }

    fn click(
        label: &str,
        runtime: Runtime,
        plugins: &PluginsState,
        data: &Temp,
        item: &str,
        value: Option<bool>,
    ) -> SidebarInputReply {
        sidebar_input_from(
            label,
            runtime,
            plugins.api(),
            &plugins.enabled_set(),
            &data.0,
            ID,
            item,
            value,
            Instant::now(),
        )
    }

    fn set_chip(plugins: &PluginsState, data: &Temp) {
        let result = dispatch(
            &plugins.enabled_set(),
            plugins.api(),
            ID,
            "ui.chips",
            r#"{"chips":[{"text":"New"}]}"#,
            &data.0,
            &FakeHost::default(),
            Instant::now(),
        );
        assert_eq!(result, Ok(json!({})));
    }

    #[test]
    fn only_the_main_window_may_call() {
        let plugins = plugins_of(Tier::Ui);
        let data = data_with_sidebar();
        let host = Arc::new(FakeHost::default());
        let waiting = open_toast(&plugins, &host, r#"{"text":"Saved","action":"Undo"}"#);
        let request = open_request(&plugins);
        set_chip(&plugins, &data);
        let (api, enabled) = (plugins.api(), plugins.enabled_set());
        let token = api.ui().mint(ID, Instant::now());

        for label in ["tray", "nowplaying", "Main", "main ", ""] {
            let answer = UiAnswer::Toast { action: true };
            assert!(!answer_from(
                label,
                api,
                &enabled,
                &request,
                answer,
                Instant::now()
            ));
            assert!(pending_from(label, Runtime::Running, api).is_empty(), "{label:?}");
            assert!(sidebar_state_from(label, Runtime::Running, api, &enabled).is_empty());
            let reply = click(label, Runtime::Running, &plugins, &data, "go", None);
            assert!(!reply.accepted && reply.frame.is_none());
            frame_event_from(label, api, ID, "crashed");
        }
        // Nothing above changed anything.
        assert_eq!(api.ui().pending_events().len(), 1);
        assert_eq!(
            sidebar_state_from(MAIN_LABEL, Runtime::Running, api, &enabled).len(),
            1
        );
        assert!(api.ui().consume(ID, &token, Instant::now()));

        assert!(answer_from(
            MAIN_LABEL,
            api,
            &enabled,
            &request,
            UiAnswer::Toast { action: false },
            Instant::now()
        ));
        assert_eq!(
            waiting.join().unwrap(),
            Ok(json!({ "result": "dismissed" }))
        );
    }

    #[test]
    fn an_answer_resolves_the_waiting_call_once() {
        let plugins = plugins_of(Tier::Ui);
        let host = Arc::new(FakeHost::default());
        let waiting = open_toast(&plugins, &host, r#"{"text":"Saved","action":"Undo"}"#);
        let (api, enabled) = (plugins.api(), plugins.enabled_set());
        let request = open_request(&plugins);

        // A prompt answer to a toast changes nothing.
        let wrong = UiAnswer::Confirm { value: true };
        assert!(!answer_from(
            MAIN_LABEL,
            api,
            &enabled,
            &request,
            wrong,
            Instant::now()
        ));
        assert_eq!(api.ui().pending_events().len(), 1);

        let answer = UiAnswer::Toast { action: true };
        assert!(answer_from(
            MAIN_LABEL,
            api,
            &enabled,
            &request,
            answer,
            Instant::now()
        ));
        let result = waiting.join().unwrap().unwrap();
        assert_eq!(result["result"], "action");
        let token = result["gesture"].as_str().unwrap();
        assert!(api.ui().consume(ID, token, Instant::now()));

        // Answered, so a second answer and an unknown id are both refused.
        assert!(!answer_from(
            MAIN_LABEL,
            api,
            &enabled,
            &request,
            answer,
            Instant::now()
        ));
        assert!(!answer_from(
            MAIN_LABEL,
            api,
            &enabled,
            "nope",
            answer,
            Instant::now()
        ));
    }

    #[test]
    fn a_toast_action_after_the_plugin_stops_serving_mints_nothing() {
        let plugins = plugins_of(Tier::Ui);
        let host = Arc::new(FakeHost::default());
        let waiting = open_toast(&plugins, &host, r#"{"text":"Saved","action":"Undo"}"#);
        let request = open_request(&plugins);
        let _withdrawn = plugins.withdraw(ID);
        let answer = UiAnswer::Toast { action: true };
        assert!(answer_from(
            MAIN_LABEL,
            plugins.api(),
            &plugins.enabled_set(),
            &request,
            answer,
            Instant::now()
        ));
        assert_eq!(
            waiting.join().unwrap(),
            Ok(json!({ "result": "dismissed" }))
        );
    }

    #[test]
    fn a_click_is_refused_for_a_stopped_plugin_while_held_or_safe_and_for_a_native_one() {
        let data = data_with_sidebar();
        let ui = plugins_of(Tier::Ui);
        assert!(click(MAIN_LABEL, Runtime::Running, &ui, &data, "go", None).accepted);

        for runtime in [Runtime::Held, Runtime::Safe] {
            assert!(!click(MAIN_LABEL, runtime, &ui, &data, "go", None).accepted);
        }

        let _withdrawn = ui.withdraw(ID);
        assert!(!click(MAIN_LABEL, Runtime::Running, &ui, &data, "go", None).accepted);

        let native = plugins_of(Tier::Native);
        let reply = click(MAIN_LABEL, Runtime::Running, &native, &data, "go", None);
        assert!(!reply.accepted && reply.frame.is_none());
    }

    #[test]
    fn an_accepted_click_carries_a_gesture_the_plugin_can_spend_once() {
        let data = data_with_sidebar();
        let plugins = plugins_of(Tier::Ui);
        let reply = click(MAIN_LABEL, Runtime::Running, &plugins, &data, "tg", Some(true));
        let frame = reply.frame.unwrap();
        assert_eq!((frame.item_id.as_str(), frame.value), ("tg", Some(true)));
        let api = plugins.api();
        assert!(api.ui().consume(ID, &frame.gesture, Instant::now()));
        assert!(!api.ui().consume(ID, &frame.gesture, Instant::now()));
    }

    #[test]
    fn a_frame_event_releases_open_requests_and_only_a_crash_drops_state() {
        let data = data_with_sidebar();
        for kind in ["detached", "crashed"] {
            let plugins = plugins_of(Tier::Ui);
            let host = Arc::new(FakeHost::default());
            let waiting = open_toast(&plugins, &host, r#"{"text":"Saved"}"#);
            set_chip(&plugins, &data);
            let (api, enabled) = (plugins.api(), plugins.enabled_set());
            let token = api.ui().mint(ID, Instant::now());

            frame_event_from(MAIN_LABEL, api, ID, kind);

            assert_eq!(
                waiting.join().unwrap(),
                Ok(json!({ "result": "dismissed" })),
                "{kind}"
            );
            assert!(api.ui().pending_events().is_empty());
            // Detached drops the gestures too; only the sidebar state tells the kinds apart.
            assert!(!api.ui().consume(ID, &token, Instant::now()), "{kind}");
            let kept = sidebar_state_from(MAIN_LABEL, Runtime::Running, api, &enabled).len();
            assert_eq!(kept, usize::from(kind == "detached"), "{kind}");
        }
    }

    #[test]
    fn an_unknown_kind_or_id_has_no_effect() {
        let data = data_with_sidebar();
        let plugins = plugins_of(Tier::Ui);
        let host = Arc::new(FakeHost::default());
        let waiting = open_toast(&plugins, &host, r#"{"text":"Saved"}"#);
        set_chip(&plugins, &data);
        let (api, enabled) = (plugins.api(), plugins.enabled_set());
        let token = api.ui().mint(ID, Instant::now());

        frame_event_from(MAIN_LABEL, api, ID, "unmounted");
        frame_event_from(MAIN_LABEL, api, ID, "");
        frame_event_from(MAIN_LABEL, api, "com.example.other", "crashed");
        frame_event_from(MAIN_LABEL, api, "../x", "crashed");

        assert_eq!(api.ui().pending_events().len(), 1);
        assert_eq!(
            sidebar_state_from(MAIN_LABEL, Runtime::Running, api, &enabled).len(),
            1
        );
        assert!(api.ui().consume(ID, &token, Instant::now()));
        api.ui().release(ID);
        waiting.join().unwrap().unwrap();
    }

    #[test]
    fn pending_and_sidebar_state_are_empty_while_held_or_safe() {
        let data = data_with_sidebar();
        let plugins = plugins_of(Tier::Ui);
        let host = Arc::new(FakeHost::default());
        let waiting = open_toast(&plugins, &host, r#"{"text":"Saved"}"#);
        set_chip(&plugins, &data);
        let (api, enabled) = (plugins.api(), plugins.enabled_set());

        for runtime in [Runtime::Held, Runtime::Safe] {
            assert!(pending_from(MAIN_LABEL, runtime, api).is_empty(), "{runtime:?}");
            assert!(sidebar_state_from(MAIN_LABEL, runtime, api, &enabled).is_empty());
        }
        assert_eq!(pending_from(MAIN_LABEL, Runtime::Running, api).len(), 1);
        assert_eq!(
            sidebar_state_from(MAIN_LABEL, Runtime::Running, api, &enabled).len(),
            1
        );
        api.ui().release(ID);
        waiting.join().unwrap().unwrap();
    }

    #[test]
    fn a_held_boot_reads_as_held_and_serves_no_click() {
        let data = data_with_sidebar();
        let registry = plugins_of(Tier::Ui).snapshot();
        let boot = BootState {
            safe_mode: false,
            unclean: true,
        };
        let held = PluginsState::new(registry, Problems::new(), boot);
        assert_eq!(held.runtime(), Runtime::Held);
        let reply = click(MAIN_LABEL, held.runtime(), &held, &data, "go", None);
        assert!(!reply.accepted && reply.frame.is_none());
        // The serving set is empty too, so a caller that skipped the runtime check is still refused.
        let reply = click(MAIN_LABEL, Runtime::Running, &held, &data, "go", None);
        assert!(!reply.accepted);
        let enabled = held.enabled_set();
        assert!(sidebar_state_from(MAIN_LABEL, held.runtime(), held.api(), &enabled).is_empty());

        held.resolve_boot(false);
        assert!(click(MAIN_LABEL, held.runtime(), &held, &data, "go", None).accepted);
    }
}
