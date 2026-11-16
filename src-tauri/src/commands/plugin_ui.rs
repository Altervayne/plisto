/*
 * The IPC commands behind plugin UI surfaces: answering a toast or prompt, re-reading what is open and
 * the live sidebar state, reporting a sidebar click, and telling Rust how a plugin's frame stands, which
 * also feeds the supervisor. Only the main window may call them. A click here is the only place a
 * gesture is minted from user input, so a plugin frame must never reach these commands itself.
 */

// -- Library Imports --
use std::path::Path;
#[cfg(windows)]
use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Manager, State, Webview};

// -- Local Imports --
use crate::plugins::api::events::Side;
use crate::plugins::api::host_event::UiEvent;
use crate::plugins::api::sidebar::{
    check_input, SidebarDelivery, SidebarInputReply, SidebarSnapshot,
};
use crate::plugins::api::state::ApiState;
use crate::plugins::api::stream::{Gone, Producer};
use crate::plugins::api::ui_state::UiAnswer;
use crate::plugins::manifest::Tier;
#[cfg(windows)]
use crate::plugins::native::NativeHost;
use crate::plugins::paths::validate_id;
#[cfg(windows)]
use crate::plugins::state::PluginsState;
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

/// Hands an accepted click on a native plugin's control to its child through `deliver`; the reply then
/// carries no frame. A click the child cannot take is refused and its gesture spent, so no one holds
/// it. A UI plugin's reply passes through.
fn deliver_native(
    reply: SidebarInputReply,
    tier: Option<Tier>,
    api: &ApiState,
    id: &str,
    deliver: impl FnOnce(&SidebarDelivery) -> bool,
    now: Instant,
) -> SidebarInputReply {
    let Some(frame) = reply.frame.as_ref().filter(|_| tier == Some(Tier::Native)) else {
        return reply;
    };
    let accepted = deliver(frame);
    if !accepted {
        api.ui().consume(id, &frame.gesture, now);
    }
    SidebarInputReply {
        accepted,
        frame: None,
    }
}

/// Frees what plugin `id` holds once its frame is gone. Both kinds end its open requests, network work,
/// a stream its frames pushed and its frames' event subscriptions, and drop its gestures; a crash also
/// drops its sidebar state. Any other label, kind or id has no effect.
fn frame_event_from(label: &str, api: &ApiState, id: &str, kind: &str) {
    if label != MAIN_LABEL || validate_id(id).is_err() {
        return;
    }
    match kind {
        "detached" => {
            api.ui().release(id);
            api.ui().drop_gestures(id);
            api.net().frame_gone(id);
            api.streams().forget(id, Gone::Off, Producer::Frame);
            api.events().drop_side(id, Side::Frame);
        }
        "crashed" => {
            api.ui().release(id);
            api.ui().drop_gestures(id);
            api.net().frame_gone(id);
            api.streams().forget(id, Gone::Off, Producer::Frame);
            api.events().drop_side(id, Side::Frame);
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
/// because the plugin's manifest may be read. A native plugin's click goes to its child from here, so
/// the reply carries no frame.
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
        let now = Instant::now();
        let reply = sidebar_input_from(
            &label, runtime, &api, &enabled, &app_data, &id, &item_id, value, now,
        );
        let tier = enabled.serving(&id).map(|serving| serving.tier);
        let deliver = |frame: &SidebarDelivery| child_takes(&app, &id, frame);
        deliver_native(reply, tier, &api, &id, deliver, now)
    })
    .await
    .unwrap_or(refused)
}

/// Sends a click to plugin `id`'s child. False when it is not running or cannot take it.
#[cfg(windows)]
fn child_takes(app: &AppHandle, id: &str, frame: &SidebarDelivery) -> bool {
    app.try_state::<Arc<NativeHost>>().is_some_and(|native| {
        native.deliver_sidebar(id, &frame.item_id, frame.value, &frame.gesture)
    })
}

#[cfg(not(windows))]
fn child_takes(_: &AppHandle, _: &str, _: &SidebarDelivery) -> bool {
    false
}

/// Feeds a frame report from `label` to the supervisor. Any other label has no effect.
#[cfg(windows)]
fn frame_status_from(
    label: &str,
    host: &NativeHost,
    plugins: &PluginsState,
    id: &str,
    kind: &str,
    reason: Option<&str>,
) {
    if label == MAIN_LABEL {
        host.frame_event(plugins, id, kind, reason);
    }
}

/// Reports how plugin `id`'s frame stands: `kind` is `"live"`, `"not_responding"`, `"crashed"` with a
/// `reason`, or `"detached"`. A crash or detach also frees what the plugin holds.
#[tauri::command]
pub fn plugin_frame_event(
    id: String,
    kind: String,
    reason: Option<String>,
    webview: Webview,
    app: AppHandle,
) {
    let state = app.state::<AppState>();
    frame_event_from(webview.label(), state.plugins.api(), &id, &kind);
    #[cfg(windows)]
    if let Some(native) = app.try_state::<Arc<NativeHost>>() {
        frame_status_from(
            webview.label(),
            &native,
            &state.plugins,
            &id,
            &kind,
            reason.as_deref(),
        );
    }
    #[cfg(not(windows))]
    let _ = reason;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::{dispatch, EndReason, FakeHost, Kind, Running};
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
            consented_network: Vec::new(),
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
    fn a_click_is_refused_for_a_stopped_plugin_and_while_held_or_safe() {
        let data = data_with_sidebar();
        let ui = plugins_of(Tier::Ui);
        assert!(click(MAIN_LABEL, Runtime::Running, &ui, &data, "go", None).accepted);

        for runtime in [Runtime::Held, Runtime::Safe] {
            assert!(!click(MAIN_LABEL, runtime, &ui, &data, "go", None).accepted);
        }

        let _withdrawn = ui.withdraw(ID);
        assert!(!click(MAIN_LABEL, Runtime::Running, &ui, &data, "go", None).accepted);
    }

    #[test]
    fn a_native_click_goes_to_the_child_and_its_gesture_only_there() {
        let data = data_with_sidebar();
        let native = plugins_of(Tier::Native);
        let api = native.api();
        let now = Instant::now();
        let deliver = |taken: bool| {
            let reply = click(MAIN_LABEL, Runtime::Running, &native, &data, "tg", Some(true));
            let mut handed = None;
            let reply = deliver_native(
                reply,
                Some(Tier::Native),
                api,
                ID,
                |frame| {
                    handed = Some((frame.item_id.clone(), frame.value, frame.gesture.clone()));
                    taken
                },
                now,
            );
            (reply, handed.unwrap())
        };

        // Taken: the frame stays in Rust, and the child's gesture is spendable once.
        let (reply, (item, value, gesture)) = deliver(true);
        assert!(reply.accepted && reply.frame.is_none());
        assert_eq!((item.as_str(), value), ("tg", Some(true)));
        assert!(api.ui().consume(ID, &gesture, now));
        assert!(!api.ui().consume(ID, &gesture, now));

        // Not taken: refused, and the gesture is gone.
        let (reply, (_, _, gesture)) = deliver(false);
        assert!(!reply.accepted && reply.frame.is_none());
        assert!(!api.ui().consume(ID, &gesture, now));

        // A refused click reaches no child, and a UI plugin's reply passes through.
        let refused = click(MAIN_LABEL, Runtime::Held, &native, &data, "go", None);
        let reply = deliver_native(refused, Some(Tier::Native), api, ID, |_| panic!(), now);
        assert!(!reply.accepted);
        let ui = plugins_of(Tier::Ui);
        let reply = click(MAIN_LABEL, Runtime::Running, &ui, &data, "go", None);
        let reply = deliver_native(reply, Some(Tier::Ui), ui.api(), ID, |_| panic!(), now);
        assert!(reply.accepted && reply.frame.is_some());
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

    /// Opens a running entry of `kind` for `id` and returns the guard with the reasons it ended with.
    fn open_net(
        api: &ApiState,
        id: &str,
        kind: Kind,
    ) -> (Running, Arc<std::sync::Mutex<Vec<EndReason>>>) {
        let fired = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = fired.clone();
        let running = api
            .net()
            .open(id, kind, None, Box::new(move |why| sink.lock().unwrap().push(why)))
            .unwrap();
        (running, fired)
    }

    #[test]
    fn a_frame_event_ends_the_plugins_network_work_and_nothing_else() {
        const OTHER: &str = "com.example.other";
        for kind in ["detached", "crashed"] {
            let plugins = plugins_of(Tier::Ui);
            let api = plugins.api();
            let (_fetch, fetch) = open_net(api, ID, Kind::Fetch);
            let (_socket, socket) = open_net(api, ID, Kind::Socket);
            let (_other, other) = open_net(api, OTHER, Kind::Stream);

            frame_event_from(MAIN_LABEL, api, ID, "unmounted");
            frame_event_from(MAIN_LABEL, api, ID, "");
            frame_event_from("tray", api, ID, kind);
            frame_event_from(MAIN_LABEL, api, "com.example.third", kind);
            assert!(fetch.lock().unwrap().is_empty(), "{kind}");
            assert_eq!(api.net().running(ID, Kind::Fetch), 1);

            frame_event_from(MAIN_LABEL, api, ID, kind);
            assert_eq!(*fetch.lock().unwrap(), [EndReason::FrameGone], "{kind}");
            assert_eq!(*socket.lock().unwrap(), [EndReason::FrameGone], "{kind}");
            assert_eq!(api.net().running(ID, Kind::Fetch), 0);
            assert_eq!(api.net().running(ID, Kind::Socket), 0);
            assert!(other.lock().unwrap().is_empty(), "{kind}");
            assert_eq!(api.net().running(OTHER, Kind::Stream), 1);
        }
    }

    #[test]
    fn frame_gone_clears_the_frame_side() {
        use crate::plugins::api::events::Topic;
        use std::collections::BTreeSet;

        const OTHER: &str = "com.example.other";
        let topics: BTreeSet<Topic> = [Topic::Theme, Topic::Locale].into();
        for kind in ["detached", "crashed"] {
            let plugins = plugins_of(Tier::Native);
            let events = plugins.api().events();
            events.replace(ID, Side::Frame, &topics, &[]);
            events.replace(ID, Side::Child, &topics, &[]);
            events.replace(OTHER, Side::Frame, &topics, &[]);

            frame_event_from("tray", plugins.api(), ID, kind);
            frame_event_from(MAIN_LABEL, plugins.api(), ID, "unmounted");
            assert_eq!(events.topics_of(ID, Side::Frame).len(), 2, "{kind}");

            frame_event_from(MAIN_LABEL, plugins.api(), ID, kind);
            assert!(events.topics_of(ID, Side::Frame).is_empty(), "{kind}");
            assert_eq!(events.topics_of(ID, Side::Child).len(), 2, "{kind}");
            assert_eq!(events.topics_of(OTHER, Side::Frame).len(), 2, "{kind}");
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

    /// A host on a fake clock whose link reaches `plugins`, booted from `data`.
    #[cfg(windows)]
    fn supervisor(
        plugins: &Arc<PluginsState>,
        data: &Temp,
    ) -> (
        NativeHost,
        Arc<crate::plugins::native::link::RecordingLink>,
        Arc<crate::plugins::native::FakeClock>,
    ) {
        use crate::plugins::native::{link::RecordingLink, FakeClock};
        let link = Arc::new(RecordingLink::default());
        link.attach(plugins, &data.0);
        let clock = Arc::new(FakeClock::new());
        let host = NativeHost::with_clock(data.0.clone(), link.clone(), clock.clone());
        (host, link, clock)
    }

    #[cfg(windows)]
    #[test]
    fn a_background_frame_is_supervised_like_a_child() {
        use crate::plugins::native::status::{CrashReason, HostState};
        let data = Temp::new("plugin-ui");
        let mut registry = plugins_of(Tier::Ui).snapshot();
        registry.entries[0].granted.push(Capability::Background);
        let plugins = Arc::new(PluginsState::new(
            registry,
            Problems::new(),
            BootState::default(),
        ));
        let (host, link, clock) = supervisor(&plugins, &data);
        let report = |label: &str, kind: &str, reason: Option<&str>| {
            frame_status_from(label, &host, &plugins, ID, kind, reason)
        };
        let state = || host.status(ID).map(|s| s.host);

        for label in ["tray", "Main", ""] {
            report(label, "live", None);
        }
        assert_eq!(state(), None);
        report(MAIN_LABEL, "live", None);
        assert_eq!(state(), Some(HostState::Running));
        report(MAIN_LABEL, "not_responding", None);
        assert_eq!(state(), Some(HostState::NotResponding));
        report(MAIN_LABEL, "live", None);
        // A crash with no known reason is not taken.
        report(MAIN_LABEL, "crashed", Some("boom"));
        report(MAIN_LABEL, "crashed", None);
        assert_eq!(state(), Some(HostState::Running));

        report(MAIN_LABEL, "crashed", Some("silent"));
        let status = host.status(ID).unwrap();
        assert_eq!(status.host, HostState::Restarting { retry_in_ms: 1000 });
        assert_eq!(status.crash.unwrap().reason, CrashReason::Silent);
        clock.advance(Duration::from_millis(999));
        host.tick();
        assert_eq!(state(), Some(HostState::Restarting { retry_in_ms: 1000 }));
        clock.advance(Duration::from_millis(1));
        host.tick();
        assert_eq!(state(), Some(HostState::Starting));

        report(MAIN_LABEL, "live", None);
        report(MAIN_LABEL, "crashed", Some("navigated"));
        assert_eq!(state(), Some(HostState::Restarting { retry_in_ms: 2000 }));
        clock.advance(Duration::from_secs(2));
        host.tick();
        assert_eq!(state(), Some(HostState::Starting));
        report(MAIN_LABEL, "crashed", Some("init"));
        assert_eq!(state(), Some(HostState::CrashLoop));
        assert_eq!(link.disabled(), [ID]);
        assert_eq!(link.notices().len(), 1);
        assert!(!plugins.is_enabled(ID), "turned off and saved");
        // No longer serving: further reports are ignored and the crash loop shows on.
        report(MAIN_LABEL, "detached", None);
        assert_eq!(state(), Some(HostState::CrashLoop));
    }

    #[cfg(windows)]
    #[test]
    fn a_page_frame_crash_waits_for_the_user_and_native_ids_are_ignored() {
        use crate::plugins::native::status::HostState;
        let data = Temp::new("plugin-ui");
        let plugins = Arc::new(plugins_of(Tier::Ui));
        let (host, link, clock) = supervisor(&plugins, &data);
        let report = |kind: &str, reason: Option<&str>| {
            frame_status_from(MAIN_LABEL, &host, &plugins, ID, kind, reason)
        };
        report("live", None);
        for _ in 0..4 {
            report("crashed", Some("silent"));
            assert_eq!(host.status(ID).unwrap().host, HostState::Stopped);
        }
        clock.advance(Duration::from_secs(10));
        host.tick();
        assert_eq!(host.status(ID).unwrap().host, HostState::Stopped);
        assert!(link.disabled().is_empty());
        report("detached", None);
        assert_eq!(host.status(ID).unwrap().host, HostState::Off);

        let native = Arc::new(plugins_of(Tier::Native));
        let (host, _, _) = supervisor(&native, &data);
        frame_status_from(MAIN_LABEL, &host, &native, ID, "live", None);
        assert!(host.status(ID).is_none());
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
