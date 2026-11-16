// The dispatch itself: who may call what, the limits every call passes, and what a refusal answers.

// -- Library Imports --
use serde_json::json;
use std::time::Duration;

// -- Local Imports --
use super::error::ApiCode;
use super::*;
use crate::plugins::lifecycle::disable;
use crate::plugins::manifest::Tier;
use crate::plugins::registry::{Entry, EntryState, Registry};
use crate::plugins::revalidate::Problems;
use crate::plugins::session::BootState;
use crate::plugins::state::PluginsState;
use crate::plugins::test_kit::{ui, Kit, ID};

fn plugins_with(granted: Vec<Capability>) -> PluginsState {
    let entry = Entry {
        id: ID.to_string(),
        version: "1.0.0".into(),
        tier: Tier::Ui,
        enabled: true,
        granted,
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

fn nothing(_: &CallCtx<'_>, _: &Map<String, Value>) -> Outcome {
    Outcome::Done(Ok(Value::Null))
}

// A table with a method needing the storage grant, as the storage methods do.
const GATED: &[MethodSpec] = &[
    MethodSpec {
        name: "test.open",
        need: Need::Ambient,
        class: RateClass::Ambient,
        run: nothing,
    },
    MethodSpec {
        name: "test.gated",
        need: Need::Cap(Capability::Storage),
        class: RateClass::StorageRead,
        run: nothing,
    },
];

fn open_toast(ctx: &CallCtx<'_>, _: &Map<String, Value>) -> Outcome {
    let ui = ctx.api.ui();
    let event = host_event::UiEvent {
        request_id: ui.next_request_id(),
        id: ctx.id.to_string(),
        kind: host_event::UiKind::Toast {
            text: "Saved".into(),
            action: None,
        },
    };
    match ui.open_toast(ctx.id, event, false, Instant::now()) {
        Ok(pending) => Outcome::Pending(pending),
        Err(e) => Outcome::Done(Err(e)),
    }
}

// One pending method and one that returns at once, on a bucket large enough for 17 admits.
const PENDING: &[MethodSpec] = &[
    MethodSpec {
        name: "test.toast",
        need: Need::Ambient,
        class: RateClass::StorageRead,
        run: open_toast,
    },
    MethodSpec {
        name: "test.open",
        need: Need::Ambient,
        class: RateClass::StorageRead,
        run: nothing,
    },
];

/// Starts `count` toast calls on their own threads and returns once all are open.
fn start_toasts(
    plugins: &PluginsState,
    host: &std::sync::Arc<FakeHost>,
    count: usize,
) -> Vec<std::thread::JoinHandle<Result<Value, ApiError>>> {
    let handles = (0..count)
        .map(|_| {
            let admitted = admit_in(
                PENDING,
                &plugins.enabled_set(),
                plugins.api(),
                ID,
                "test.toast",
                2,
                Instant::now(),
            )
            .unwrap();
            let (host, api) = (host.clone(), plugins.api().clone());
            std::thread::spawn(move || run(&admitted, "{}", Path::new("unused"), &*host, &api))
        })
        .collect();
    let started = Instant::now();
    while plugins.api().ui().pending_events().len() < count {
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "calls never opened"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    handles
}

#[test]
fn a_pending_call_holds_its_in_flight_slot_until_it_resolves() {
    let plugins = plugins_with(Vec::new());
    let enabled = plugins.enabled_set();
    let api = plugins.api();
    let host = std::sync::Arc::new(FakeHost::default());
    let waiting = start_toasts(&plugins, &host, 1);
    let t0 = Instant::now();
    let held: Vec<Admitted> = (0..15)
        .map(|_| admit_in(PENDING, &enabled, api, ID, "test.open", 2, t0).unwrap())
        .collect();
    assert_eq!(api.in_flight(ID), 16);
    let busy = admit_in(PENDING, &enabled, api, ID, "test.open", 2, t0);
    assert_eq!(code(busy), Some(ApiCode::Busy));

    api.ui().release(ID);
    for handle in waiting {
        assert_eq!(handle.join().unwrap(), Ok(json!({ "result": "dismissed" })));
    }
    assert_eq!(api.in_flight(ID), 15);
    drop(held);
    assert_eq!(api.in_flight(ID), 0);
}

#[test]
fn a_later_job_resolves_through_run_and_holds_its_slot_until_then() {
    let plugins = plugins_with(Vec::new());
    let api = plugins.api();
    let admitted = admit_in(
        LATER_TABLE,
        &plugins.enabled_set(),
        api,
        ID,
        "test.later",
        2,
        Instant::now(),
    )
    .unwrap();
    let result = run(
        &admitted,
        "{}",
        Path::new("unused"),
        &FakeHost::default(),
        api,
    );
    assert_eq!(result, Ok(json!({ "id": ID, "in_flight": 1 })));
    drop(admitted);
    assert_eq!(api.in_flight(ID), 0);
}

#[test]
fn start_hands_back_a_later_job_and_answers_the_rest() {
    let plugins = plugins_with(Vec::new());
    let enabled = plugins.enabled_set();
    let api = plugins.api();
    let host = FakeHost::default();
    let t0 = Instant::now();
    let admitted = admit_in(LATER_TABLE, &enabled, api, ID, "test.later", 2, t0).unwrap();
    let Started::Later(job) = start(&admitted, "{}", Path::new("unused"), &host, api) else {
        panic!("expected a later job");
    };
    assert_eq!(api.in_flight(ID), 1);
    let result = tauri::async_runtime::block_on(job);
    assert_eq!(result, Ok(json!({ "id": ID, "in_flight": 1 })));
    drop(admitted);
    assert_eq!(api.in_flight(ID), 0);

    // Bad arguments never reach the handler.
    let admitted = admit_in(LATER_TABLE, &enabled, api, ID, "test.later", 2, t0).unwrap();
    let Started::Done(Err(error)) = start(&admitted, "[]", Path::new("unused"), &host, api) else {
        panic!("expected an answer");
    };
    assert_eq!(error.code, ApiCode::InvalidArgs);
    let admitted = admit(&enabled, api, ID, "app.info", 2, t0).unwrap();
    let started = start(&admitted, "{}", Path::new("unused"), &host, api);
    assert!(matches!(started, Started::Done(Ok(_))));
}

#[test]
fn forget_releases_open_calls_and_drops_gestures() {
    let plugins = plugins_with(Vec::new());
    let api = plugins.api();
    let host = std::sync::Arc::new(FakeHost::default());
    let waiting = start_toasts(&plugins, &host, 1);
    let token = api.ui().mint(ID, Instant::now());

    api.forget(ID);
    for handle in waiting {
        assert_eq!(handle.join().unwrap(), Ok(json!({ "result": "dismissed" })));
    }
    assert!(api.ui().pending_events().is_empty());
    assert_eq!(host.events.lock().unwrap().len(), 1);
    assert!(!api.ui().consume(ID, &token, Instant::now()));
    assert_eq!(api.in_flight(ID), 0);
}

fn code(result: Result<Admitted, ApiError>) -> Option<ApiCode> {
    result.err().map(|e| e.code)
}

#[test]
fn admit_answers_each_code_at_its_step() {
    let plugins = plugins_with(Vec::new());
    let enabled = plugins.enabled_set();
    let api = ApiState::default();
    let t0 = Instant::now();
    let admit =
        |id: &str, method: &str, len: usize| admit_in(GATED, &enabled, &api, id, method, len, t0);

    // 1. A broken id is not found, before anything else is looked at.
    assert_eq!(
        code(admit("Bad Id", "nope", usize::MAX)),
        Some(ApiCode::NotFound)
    );
    // 2. A valid id that is not serving.
    assert_eq!(
        code(admit("com.example.off", "test.open", 2)),
        Some(ApiCode::Unavailable)
    );
    // 4. Unknown method, after the `all` token is spent.
    assert_eq!(code(admit(ID, "ui.toast", 2)), Some(ApiCode::UnknownMethod));
    // 5. Too large comes before the grant check.
    assert_eq!(
        code(admit(ID, "test.gated", MAX_ARGS_BYTES + 1)),
        Some(ApiCode::TooLarge)
    );
    assert!(admit(ID, "test.open", MAX_ARGS_BYTES).is_ok());
    // 6. A method needing a capability the plugin was not granted.
    assert_eq!(code(admit(ID, "test.gated", 2)), Some(ApiCode::Denied));
    // 7. The class bucket: Ambient holds 10 and one was spent above.
    for _ in 0..9 {
        assert!(admit(ID, "test.open", 2).is_ok());
    }
    let limited = admit(ID, "test.open", 2).err().unwrap();
    assert_eq!(limited.code, ApiCode::RateLimited);
    assert_eq!(limited.retry_after_ms, Some(500));
    // 3. The `all` bucket: 14 spent so far; unknown methods spend it too, then everything is
    // refused before the table is consulted.
    for _ in 0..86 {
        assert_eq!(code(admit(ID, "ui.toast", 2)), Some(ApiCode::UnknownMethod));
    }
    let limited = admit(ID, "ui.toast", 2).err().unwrap();
    assert_eq!(limited.code, ApiCode::RateLimited);
    assert_eq!(limited.retry_after_ms, Some(20));
}

#[test]
fn a_granted_capability_is_admitted() {
    let plugins = plugins_with(vec![Capability::Storage]);
    let api = ApiState::default();
    let admitted = admit_in(
        GATED,
        &plugins.enabled_set(),
        &api,
        ID,
        "test.gated",
        2,
        Instant::now(),
    );
    assert!(admitted.is_ok());
}

#[test]
fn the_seventeenth_admitted_call_is_busy_and_a_finished_one_frees_a_slot() {
    let plugins = plugins_with(Vec::new());
    let enabled = plugins.enabled_set();
    let api = ApiState::default();
    let t0 = Instant::now();
    let mut held: Vec<Admitted> = (0..16)
        .map(|_| admit(&enabled, &api, ID, "log.write", 2, t0).unwrap())
        .collect();
    let busy = admit(&enabled, &api, ID, "log.write", 2, t0);
    assert_eq!(code(busy), Some(ApiCode::Busy));
    held.pop();
    assert!(admit(&enabled, &api, ID, "log.write", 2, t0).is_ok());
    drop(held);
    assert_eq!(api.in_flight(ID), 0);
}

#[test]
fn rate_refills_with_the_injected_clock() {
    let plugins = plugins_with(Vec::new());
    let enabled = plugins.enabled_set();
    let api = ApiState::default();
    let t0 = Instant::now();
    for _ in 0..10 {
        admit(&enabled, &api, ID, "app.info", 2, t0).unwrap();
    }
    assert!(admit(&enabled, &api, ID, "app.info", 2, t0).is_err());
    let later = t0 + Duration::from_millis(500);
    assert!(admit(&enabled, &api, ID, "app.info", 2, later).is_ok());
}

#[test]
fn dispatch_answers_app_info_for_the_caller() {
    let plugins = plugins_with(vec![Capability::Storage]);
    let host = FakeHost::default().with(app::SETTING_THEME, "dark");
    let info = dispatch(
        &plugins.enabled_set(),
        plugins.api(),
        ID,
        "app.info",
        r#"{"plugin_id": "com.example.other"}"#,
        Path::new("unused"),
        &host,
        Instant::now(),
    )
    .unwrap();
    // An id in the arguments is ignored.
    assert_eq!(info["plugin_id"], ID);
    assert_eq!(info["theme"], "dark");
    assert_eq!(info["granted"], serde_json::json!(["storage"]));
}

#[test]
fn arguments_that_are_not_a_json_object_are_invalid() {
    let plugins = plugins_with(Vec::new());
    let host = FakeHost::default();
    for args in ["", "not json", "[]", "5", "null", "\"{}\"", "{\"a\":"] {
        let error = dispatch(
            &plugins.enabled_set(),
            plugins.api(),
            ID,
            "app.methods",
            args,
            Path::new("unused"),
            &host,
            Instant::now() + Duration::from_secs(60),
        )
        .unwrap_err();
        assert_eq!(error.code, ApiCode::InvalidArgs, "{args:?}");
    }
}

#[test]
fn methods_of_other_namespaces_are_unknown() {
    let plugins = plugins_with(Vec::new());
    let enabled = plugins.enabled_set();
    let api = ApiState::default();
    for method in [
        "ui.missing",
        "library.missing",
        "playback.missing",
        "queue.clear",
        "events.unsubscribe",
        "events.on",
        "plugin.call",
        "app",
        "app.info.x",
    ] {
        let result = admit(&enabled, &api, ID, method, 2, Instant::now());
        assert_eq!(code(result), Some(ApiCode::UnknownMethod), "{method}");
    }
}

fn native_with(granted: Vec<Capability>) -> PluginsState {
    let mut registry = plugins_with(granted).snapshot();
    registry.entries[0].tier = Tier::Native;
    PluginsState::new(registry, Problems::new(), BootState::default())
}

#[test]
fn a_native_page_relays_plugin_calls_to_its_own_child() {
    let plugins = native_with(Vec::new());
    let host = FakeHost {
        relay_answer: Some(Ok(json!({ "pong": true }))),
        ..FakeHost::default()
    };
    let call = |method: &str, args: &str| {
        dispatch(
            &plugins.enabled_set(),
            plugins.api(),
            ID,
            method,
            args,
            Path::new("unused"),
            &host,
            Instant::now(),
        )
    };
    assert_eq!(
        call("plugin.ping", r#"{"a":1}"#),
        Ok(json!({ "pong": true }))
    );
    assert_eq!(call("plugin.x.y-z_0", "{}"), Ok(json!({ "pong": true })));
    assert_eq!(
        *host.relayed.lock().unwrap(),
        [
            (ID.to_string(), "ping".to_string(), json!({ "a": 1 })),
            (ID.to_string(), "x.y-z_0".to_string(), json!({})),
        ]
    );
    // The arguments are checked as for any method before the child is asked.
    let refused = call("plugin.ping", "[]").unwrap_err();
    assert_eq!(refused.code, ApiCode::InvalidArgs);
    assert_eq!(host.relayed.lock().unwrap().len(), 2);
}

#[test]
fn a_relay_name_is_checked_and_a_ui_plugin_has_no_relay() {
    let native = native_with(Vec::new());
    let ui = plugins_with(Vec::new());
    let api = ApiState::default();
    let t0 = Instant::now();
    let admit_on = |plugins: &PluginsState, method: &str| {
        code(admit(&plugins.enabled_set(), &api, ID, method, 2, t0))
    };
    let long = format!("plugin.{}", "a".repeat(65));
    for bad in [
        "plugin.",
        "plugin.Ping",
        "plugin.a b",
        "plugin.\u{e9}",
        long.as_str(),
    ] {
        assert_eq!(admit_on(&native, bad), Some(ApiCode::InvalidArgs), "{bad}");
    }
    assert_eq!(
        admit_on(&native, &format!("plugin.{}", "a".repeat(64))),
        None
    );
    assert_eq!(admit_on(&ui, "plugin.x"), Some(ApiCode::UnknownMethod));
    assert!(method_names()
        .iter()
        .all(|name| !name.starts_with(RELAY_PREFIX)));
}

#[test]
fn the_relay_bucket_holds_40_and_refills_20_per_second() {
    let plugins = native_with(Vec::new());
    let enabled = plugins.enabled_set();
    let api = ApiState::default();
    let t0 = Instant::now();
    for _ in 0..40 {
        assert!(admit(&enabled, &api, ID, "plugin.ping", 2, t0).is_ok());
    }
    let limited = admit(&enabled, &api, ID, "plugin.ping", 2, t0)
        .err()
        .unwrap();
    assert_eq!(limited.code, ApiCode::RateLimited);
    assert_eq!(limited.retry_after_ms, Some(50));
    let later = t0 + Duration::from_millis(50);
    assert!(admit(&enabled, &api, ID, "plugin.ping", 2, later).is_ok());
}

#[test]
fn a_child_is_admitted_as_a_frame_is_except_for_the_frame_namespaces() {
    let plugins = native_with(vec![Capability::Storage]);
    let enabled = plugins.enabled_set();
    let api = ApiState::default();
    let t0 = Instant::now();
    let child = |method: &str, len: usize| {
        code(admit_from(
            Caller::Child,
            &enabled,
            &api,
            ID,
            method,
            len,
            t0,
        ))
    };
    for method in ["plugin.ping", "net.fetch", "net.socket.open", "net.x"] {
        assert_eq!(child(method, 2), Some(ApiCode::UnknownMethod), "{method}");
    }
    assert_eq!(child("ui.toast", 2), Some(ApiCode::Denied));
    assert_eq!(
        child("app.info", MAX_ARGS_BYTES + 1),
        Some(ApiCode::TooLarge)
    );
    assert_eq!(child("app.info", 2), None);
    // A plugin that is not serving is refused, whoever calls.
    assert_eq!(
        code(admit_from(
            Caller::Child,
            &enabled,
            &api,
            "com.example.off",
            "app.info",
            2,
            t0
        )),
        Some(ApiCode::Unavailable)
    );
    // Frames and the child share the in-flight slots.
    let held: Vec<Admitted> = (0..16)
        .map(|_| admit(&enabled, &api, ID, "log.write", 2, t0).unwrap())
        .collect();
    assert_eq!(child("log.write", 2), Some(ApiCode::Busy));
    drop(held);
    assert_eq!(child("log.write", 2), None);
}

#[test]
fn calls_follow_the_serving_set_through_disable_withdraw_and_replace() {
    let kit = Kit::new();
    kit.install(&ui("1.0.0", &["storage"]));
    let enabled = kit.plugins.enabled_set();
    let api = kit.plugins.api();
    let t0 = Instant::now();
    let call = |at: Duration| code(admit(&enabled, api, ID, "log.write", 2, t0 + at));

    // Installed but not enabled.
    assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));
    kit.enable(&["storage"]);
    assert_eq!(call(Duration::ZERO), None);
    let serving = enabled.serving(ID).unwrap();
    assert_eq!(serving.granted, vec![Capability::Storage]);
    assert_eq!(serving.version, "1.0.0");

    disable(&kit.data, &kit.plugins, ID).unwrap();
    assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));

    kit.enable(&["storage"]);
    assert_eq!(call(Duration::ZERO), None);
    let withdrawn = kit.plugins.withdraw(ID);
    assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));

    // A change while the plugin is withdrawn does not put it back; the end of the withdraw does.
    let registry = kit.plugins.snapshot();
    kit.plugins.replace(registry.clone(), Problems::new());
    assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));
    drop(withdrawn);
    assert_eq!(call(Duration::ZERO), None);
    let mut off = registry;
    off.entries[0].enabled = false;
    kit.plugins.replace(off, Problems::new());
    assert_eq!(call(Duration::ZERO), Some(ApiCode::Unavailable));
}

#[test]
fn disabling_forgets_the_plugins_api_state() {
    let kit = Kit::new();
    kit.install(&ui("1.0.0", &[]));
    kit.enable(&[]);
    let enabled = kit.plugins.enabled_set();
    let api = kit.plugins.api();
    let t0 = Instant::now();
    for _ in 0..10 {
        admit(&enabled, api, ID, "app.info", 2, t0).unwrap();
    }
    assert!(admit(&enabled, api, ID, "app.info", 2, t0).is_err());
    api.set_page_open(ID, true);

    disable(&kit.data, &kit.plugins, ID).unwrap();
    assert_eq!(kit.stops(), [ID]);
    assert!(!api.has_buckets(ID));
    assert_eq!(api.open_page(), None);

    // Re-enabled, the plugin starts with full buckets.
    kit.enable(&[]);
    assert!(admit(&enabled, api, ID, "app.info", 2, t0).is_ok());
}
