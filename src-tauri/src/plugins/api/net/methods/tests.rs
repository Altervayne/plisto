// The network methods through the method table, and a socket against the local test server with its
// events recorded as the host events the main window receives.

// -- Library Imports --
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Instant;

// -- Local Imports --
use super::super::state::Kind;
use super::*;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::state::ApiState;
use crate::plugins::api::{
    admit, admit_from, method_names, start, table, Caller, FakeHost, Started,
};
use crate::plugins::manifest::Tier;
use crate::plugins::state::{EnabledSet, Serving};

const ID: &str = "com.example.demo";
const SEVEN: [&str; 7] = [
    "net.fetch",
    "net.abort",
    "net.stream.ack",
    "net.stream.cancel",
    "net.socket.open",
    "net.socket.send",
    "net.socket.close",
];

type Code = (ApiCode, Option<&'static str>);

fn code(result: &Result<Value, ApiError>) -> Code {
    match result {
        Ok(value) => panic!("expected an error, got {value}"),
        Err(error) => (error.code, error.reason),
    }
}

fn serving(tier: Tier, granted: Vec<Capability>, origins: Vec<String>) -> EnabledSet {
    EnabledSet::only(
        ID,
        Serving {
            tier,
            version: "1.0.0".into(),
            granted,
            origins: origins.into(),
            dev_mode: false,
        },
    )
}

fn granted(origins: Vec<String>) -> EnabledSet {
    serving(Tier::Ui, vec![Capability::Network], origins)
}

/// Admits and runs one call as a frame's, awaiting a later job here.
async fn call(
    host: &FakeHost,
    enabled: &EnabledSet,
    api: &ApiState,
    method: &str,
    args: Value,
) -> Result<Value, ApiError> {
    call_as(ID, host, enabled, api, method, args).await
}

/// `call` for plugin `id`.
async fn call_as(
    id: &str,
    host: &FakeHost,
    enabled: &EnabledSet,
    api: &ApiState,
    method: &str,
    args: Value,
) -> Result<Value, ApiError> {
    let text = args.to_string();
    let admitted = admit(enabled, api, id, method, text.len(), Instant::now())?;
    match start(&admitted, &text, Path::new("unused"), host, api) {
        Started::Done(result) => result,
        Started::Later(job) => job.await,
    }
}

fn args(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

// ---- Table ----

#[test]
fn app_methods_lists_the_seven_with_the_grant_and_their_classes() {
    let names = method_names();
    for name in SEVEN {
        assert!(names.contains(&name), "{name}");
    }
    for spec in table().iter().filter(|m| m.name.starts_with("net.")) {
        assert_eq!(spec.need, Need::Cap(Capability::Network), "{}", spec.name);
        let class = match spec.name {
            "net.fetch" | "net.socket.open" => RateClass::Net,
            "net.stream.ack" => RateClass::NetStream,
            _ => RateClass::NetSend,
        };
        assert_eq!(spec.class, class, "{}", spec.name);
    }
    let listed = names.iter().filter(|n| n.starts_with("net.")).count();
    assert_eq!(listed, SEVEN.len());
}

#[test]
fn a_plugin_without_the_network_grant_is_denied_on_all_seven() {
    let enabled = serving(Tier::Ui, vec![Capability::Storage], Vec::new());
    let api = ApiState::default();
    for method in SEVEN {
        let refused = admit(&enabled, &api, ID, method, 2, Instant::now());
        assert_eq!(
            refused.err().map(|e| e.code),
            Some(ApiCode::Denied),
            "{method}"
        );
    }
}

#[test]
fn net_fetch_through_plugin_call_is_refused_as_the_wrong_transport() {
    let enabled = granted(Vec::new());
    let api = ApiState::default();
    let admitted = admit(&enabled, &api, ID, "net.fetch", 2, Instant::now()).unwrap();
    let host = FakeHost::default();
    let Started::Done(result) = start(&admitted, "{}", Path::new("unused"), &host, &api) else {
        panic!("expected an answer");
    };
    assert_eq!(code(&result), (ApiCode::InvalidArgs, Some(WRONG_TRANSPORT)));
}

#[test]
fn a_native_child_still_cannot_open_a_socket_when_its_plugin_is_granted() {
    let enabled = serving(Tier::Native, vec![Capability::Network], Vec::new());
    let api = ApiState::default();
    let now = Instant::now();
    for method in SEVEN {
        let child = admit_from(Caller::Child, &enabled, &api, ID, method, 2, now);
        assert_eq!(
            child.err().map(|e| e.code),
            Some(ApiCode::UnknownMethod),
            "{method}"
        );
    }
    // The plugin's page may.
    assert!(admit(&enabled, &api, ID, "net.socket.open", 2, now).is_ok());
}

#[test]
fn each_class_bucket_limits_its_methods() {
    for (method, capacity) in [
        ("net.socket.open", 30),
        ("net.abort", 40),
        ("net.stream.ack", 40),
    ] {
        let enabled = granted(Vec::new());
        let api = ApiState::default();
        let now = Instant::now();
        for _ in 0..capacity {
            assert!(
                admit(&enabled, &api, ID, method, 2, now).is_ok(),
                "{method}"
            );
        }
        let limited = admit(&enabled, &api, ID, method, 2, now).err().unwrap();
        assert_eq!(limited.code, ApiCode::RateLimited, "{method}");
    }
}

// ---- Arguments ----

const UA: &str = "Plisto/2.7.0 (com.example.demo/1.0.0)";

fn fetch_code(value: Value, body: Vec<u8>) -> Code {
    match fetch_args(&args(value), body, UA.into()) {
        Ok(_) => panic!("expected an error"),
        Err(error) => (error.code, error.reason),
    }
}

#[test]
fn fetch_arguments_are_checked_before_the_engine() {
    let invalid = (ApiCode::InvalidArgs, None);
    let url = "https://a.example/";
    for bad in [
        json!({}),
        json!({ "url": 5 }),
        json!({ "url": url, "method": "get" }),
        json!({ "url": url, "method": "TRACE" }),
        json!({ "url": url, "method": 1 }),
        json!({ "url": url, "headers": ["a", "b"] }),
        json!({ "url": url, "headers": { "x-a": 1 } }),
        json!({ "url": url, "redirect": "follow-all" }),
        json!({ "url": url, "timeout_ms": 999 }),
        json!({ "url": url, "timeout_ms": 120_001 }),
        json!({ "url": url, "timeout_ms": 1.5 }),
        json!({ "url": url, "timeout_ms": "30000" }),
        json!({ "url": url, "stream": "yes" }),
        json!({ "url": url, "stream": true, "idle_ms": 4_999 }),
        json!({ "url": url, "stream": true, "idle_ms": 600_001 }),
        json!({ "url": url, "stream": true, "method": "HEAD" }),
        json!({ "url": url, "abort_key": "" }),
        json!({ "url": url, "abort_key": "a b" }),
        json!({ "url": url, "abort_key": "a".repeat(65) }),
        json!({ "url": url, "abort_key": 7 }),
    ] {
        assert_eq!(fetch_code(bad.clone(), Vec::new()), invalid, "{bad}");
    }
    // A body with GET or HEAD, and one past 1 MiB.
    assert_eq!(fetch_code(json!({ "url": url }), vec![1]), invalid);
    assert_eq!(
        fetch_code(json!({ "url": url, "method": "HEAD" }), vec![1]),
        invalid
    );
    assert_eq!(
        fetch_code(
            json!({ "url": url, "method": "POST" }),
            vec![0; super::super::MAX_REQUEST_BODY + 1]
        ),
        (ApiCode::TooLarge, Some(super::super::REQUEST_BODY))
    );

    let ok = fetch_args(
        &args(json!({
            "url": url, "method": "PUT", "headers": { "x-a": "1" }, "redirect": "manual",
            "timeout_ms": 1000, "stream": true, "idle_ms": 5000, "abort_key": "k~1", "extra": true
        })),
        vec![9; super::super::MAX_REQUEST_BODY],
        UA.into(),
    )
    .unwrap();
    assert!(ok.stream);
    assert_eq!(ok.idle, Duration::from_millis(5000));
    assert_eq!(ok.request.method, Method::Put);
    assert_eq!(ok.request.redirect, RedirectMode::Manual);
    assert_eq!(ok.request.timeout, Duration::from_millis(1000));
    assert_eq!(ok.request.abort_key.as_deref(), Some("k~1"));
    assert_eq!(ok.request.headers, [("x-a".to_string(), "1".to_string())]);
    assert_eq!(ok.request.user_agent, UA);

    let defaults = fetch_args(
        &args(json!({ "url": url, "method": null })),
        Vec::new(),
        UA.into(),
    )
    .unwrap();
    assert!(!defaults.stream);
    assert_eq!(defaults.request.method, Method::Get);
    assert_eq!(defaults.request.redirect, RedirectMode::Follow);
    assert_eq!(defaults.request.timeout, Duration::from_millis(30_000));
}

#[tokio::test(flavor = "multi_thread")]
async fn call_arguments_are_checked_before_the_engine() {
    let fx = NetFixture::new().await;
    let host = FakeHost {
        net: Some(fx.engine()),
        ..FakeHost::default()
    };
    let enabled = granted(vec![fx.origin()]);
    let api = ApiState::default();
    for (method, bad) in [
        ("net.abort", json!({})),
        ("net.abort", json!({ "abort_key": "" })),
        ("net.abort", json!({ "abort_key": "\u{e9}" })),
        ("net.stream.ack", json!({ "stream": "t1" })),
        ("net.stream.ack", json!({ "stream": "t1", "bytes": -1 })),
        ("net.stream.ack", json!({ "stream": 1, "bytes": 0 })),
        ("net.stream.cancel", json!({})),
        ("net.socket.open", json!({})),
        (
            "net.socket.open",
            json!({ "url": fx.ws_url("/ws"), "protocols": "chat" }),
        ),
        (
            "net.socket.open",
            json!({ "url": fx.ws_url("/ws"), "protocols": [1] }),
        ),
        (
            "net.socket.open",
            json!({ "url": fx.ws_url("/ws"), "headers": { "a": true } }),
        ),
        (
            "net.socket.open",
            json!({ "url": fx.ws_url("/ws"), "timeout_ms": 999 }),
        ),
        (
            "net.socket.open",
            json!({ "url": fx.ws_url("/ws"), "timeout_ms": 30_001 }),
        ),
        ("net.socket.send", json!({ "socket": "s1" })),
        (
            "net.socket.send",
            json!({ "socket": "s1", "text": "a", "data_b64": "AA==" }),
        ),
        (
            "net.socket.send",
            json!({ "socket": "s1", "data_b64": "not base64!" }),
        ),
        ("net.socket.send", json!({ "socket": "s1", "text": 5 })),
        ("net.socket.send", json!({ "text": "a" })),
        ("net.socket.close", json!({})),
        (
            "net.socket.close",
            json!({ "socket": "s1", "code": 70_000 }),
        ),
        ("net.socket.close", json!({ "socket": "s1", "code": 1001 })),
        ("net.socket.close", json!({ "socket": "s1", "reason": 1 })),
    ] {
        let result = call(&host, &enabled, &api, method, bad.clone()).await;
        assert_eq!(code(&result).0, ApiCode::InvalidArgs, "{method} {bad}");
    }
    // Well-formed calls on ids that are not this plugin's.
    for (method, unknown) in [
        ("net.stream.ack", json!({ "stream": "t999999", "bytes": 0 })),
        ("net.stream.cancel", json!({ "stream": "t999999" })),
        (
            "net.socket.send",
            json!({ "socket": "s999999", "text": "a" }),
        ),
        ("net.socket.close", json!({ "socket": "s999999" })),
    ] {
        let result = call(&host, &enabled, &api, method, unknown).await;
        assert_eq!(code(&result), (ApiCode::NotFound, None), "{method}");
    }
    let aborted = call(
        &host,
        &enabled,
        &api,
        "net.abort",
        json!({ "abort_key": "k" }),
    )
    .await;
    assert_eq!(aborted, Ok(json!({ "aborted": 0 })));
    assert!(fx.events().is_empty());
}

#[test]
fn a_host_without_an_engine_answers_unavailable() {
    let host = FakeHost::default();
    let enabled = granted(Vec::new());
    let api = ApiState::default();
    let result = tauri::async_runtime::block_on(call(
        &host,
        &enabled,
        &api,
        "net.socket.open",
        json!({ "url": "wss://a.example/" }),
    ));
    assert_eq!(code(&result), (ApiCode::Unavailable, None));
}

// ---- End to end ----

fn keys(payload: &Value) -> BTreeSet<&str> {
    payload
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_socket_opens_sends_and_closes_through_the_method_table() {
    let fx = NetFixture::new().await;
    let host = FakeHost {
        net: Some(fx.engine()),
        ..FakeHost::default()
    };
    let enabled = granted(vec![fx.origin()]);
    let api = ApiState::default();

    let opened = call(
        &host,
        &enabled,
        &api,
        "net.socket.open",
        json!({ "url": fx.ws_url("/ws") }),
    )
    .await
    .unwrap();
    assert_eq!(keys(&opened), BTreeSet::from(["socket", "protocol"]));
    assert_eq!(opened["protocol"], Value::Null);
    let socket = opened["socket"].as_str().unwrap().to_string();
    assert!(socket.starts_with('s'));
    // A socket holds no in-flight slot once open.
    assert_eq!(api.in_flight(ID), 0);

    let sent = json!({ "socket": socket, "text": "hello" });
    assert_eq!(
        call(&host, &enabled, &api, "net.socket.send", sent).await,
        Ok(json!({}))
    );
    let sent = json!({ "socket": socket, "data_b64": "AAE=" });
    assert_eq!(
        call(&host, &enabled, &api, "net.socket.send", sent).await,
        Ok(json!({}))
    );
    assert!(fx.until(|events| events.len() >= 2).await);

    let closed = json!({ "socket": socket, "code": 1000, "reason": "bye" });
    assert_eq!(
        call(&host, &enabled, &api, "net.socket.close", closed).await,
        Ok(json!({}))
    );
    let is_close = |payload: &Value| payload["kind"] == "close";
    assert!(
        fx.until(|events| events.iter().any(|(_, p)| is_close(p)))
            .await
    );

    let events = fx.events();
    assert!(events.iter().all(|(name, _)| *name == "plugins:net"));
    let payloads: Vec<&Value> = events.iter().map(|(_, p)| p).collect();
    assert_eq!(
        *payloads[0],
        json!({ "id": ID, "socket": socket, "kind": "text", "data": "hello" })
    );
    assert_eq!(
        *payloads[1],
        json!({ "id": ID, "socket": socket, "kind": "binary", "data_b64": "AAE=" })
    );
    let last = payloads.last().unwrap();
    assert_eq!(
        keys(last),
        BTreeSet::from(["id", "socket", "kind", "code", "reason", "clean"])
    );
    assert_eq!(last["code"], 1000);
    assert!(last["code"].is_u64());
    assert_eq!(payloads.iter().filter(|p| is_close(p)).count(), 1);

    // Closed: the id is gone.
    let again = json!({ "socket": socket, "text": "late" });
    let late = call(&host, &enabled, &api, "net.socket.send", again).await;
    assert_eq!(code(&late), (ApiCode::NotFound, None));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_is_acknowledged_and_cancelled_through_the_method_table() {
    let fx = NetFixture::new().await;
    let host = FakeHost {
        net: Some(fx.engine()),
        ..FakeHost::default()
    };
    let enabled = granted(vec![fx.origin()]);
    let api = ApiState::default();

    let text = json!({ "url": fx.url("/stream"), "stream": true }).to_string();
    let admitted = admit(&enabled, &api, ID, "net.fetch", text.len(), Instant::now()).unwrap();
    let opened = fetch(admitted, &text, Vec::new(), fx.engine(), api.net().clone())
        .await
        .unwrap();
    assert!(opened.body.is_none());
    assert_eq!(opened.result["status"], 200);
    let stream = opened.result["stream"].as_str().unwrap().to_string();
    // The in-flight slot was released at the headers.
    assert_eq!(api.in_flight(ID), 0);

    assert!(fx.until(|events| !events.is_empty()).await);
    let acked = json!({ "stream": stream, "bytes": 0 });
    assert_eq!(
        call(&host, &enabled, &api, "net.stream.ack", acked).await,
        Ok(json!({}))
    );
    let cancel = json!({ "stream": stream });
    assert_eq!(
        call(&host, &enabled, &api, "net.stream.cancel", cancel).await,
        Ok(json!({}))
    );
    let ended = |p: &Value| p["kind"] == "end" || p["kind"] == "error";
    assert!(
        fx.until(|events| events.iter().any(|(_, p)| ended(p)))
            .await
    );

    let events = fx.events();
    let last = &events.last().unwrap().1;
    assert_eq!(
        *last,
        json!({ "id": ID, "stream": stream, "kind": "error", "code": "aborted", "reason": "abort" })
    );
    assert_eq!(events.iter().filter(|(_, p)| ended(p)).count(), 1);
    for (name, payload) in &events[..events.len() - 1] {
        assert_eq!(*name, "plugins:net");
        assert_eq!(
            keys(payload),
            BTreeSet::from(["id", "stream", "kind", "seq", "data_b64"])
        );
    }
    let late = call(
        &host,
        &enabled,
        &api,
        "net.stream.ack",
        json!({ "stream": stream, "bytes": 0 }),
    )
    .await;
    assert_eq!(code(&late), (ApiCode::NotFound, None));
}

// ---- Admitted before the plugin stopped or lost its frame ----

/// The events that end a plugin's network work, each with what work registered after it answers.
fn ending_events() -> [(fn(&ApiState), Code); 2] {
    [
        (|api| api.forget(ID), (ApiCode::Unavailable, None)),
        (
            |api| api.net().frame_gone(ID),
            (ApiCode::Aborted, Some("frame_gone")),
        ),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_socket_admitted_before_the_plugin_stopped_or_lost_its_frame_never_opens() {
    let fx = NetFixture::new().await;
    let host = FakeHost {
        net: Some(fx.engine()),
        ..FakeHost::default()
    };
    let enabled = granted(vec![fx.origin()]);
    for (end, expected) in ending_events() {
        let api = ApiState::default();
        let text = json!({ "url": fx.ws_url("/ws") }).to_string();
        let now = Instant::now();
        let admitted = admit(&enabled, &api, ID, "net.socket.open", text.len(), now).unwrap();
        let Started::Later(job) = start(&admitted, &text, Path::new("unused"), &host, &api) else {
            panic!("expected a later job");
        };
        end(&api);
        assert_eq!(code(&job.await), expected);
        drop(admitted);
        assert_eq!(api.net().running(ID, Kind::Socket), 0);
        assert_eq!(api.in_flight(ID), 0);
    }
    assert_eq!(fx.connections(), 0);
    assert!(fx.events().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fetch_admitted_before_the_plugin_stopped_or_lost_its_frame_is_refused() {
    let fx = NetFixture::new().await;
    let enabled = granted(vec![fx.origin()]);
    for stream in [false, true] {
        for (end, expected) in ending_events() {
            let api = ApiState::default();
            let text = json!({ "url": fx.url("/bin"), "stream": stream }).to_string();
            let now = Instant::now();
            let admitted = admit(&enabled, &api, ID, "net.fetch", text.len(), now).unwrap();
            end(&api);
            let net = api.net().clone();
            let fetched = fetch(admitted, &text, Vec::new(), fx.engine(), net).await;
            assert_eq!(code(&fetched.map(|f| f.result)), expected, "{stream}");
            assert_eq!(api.net().running(ID, Kind::Fetch), 0);
            assert_eq!(api.net().running(ID, Kind::Stream), 0);
            assert_eq!(api.in_flight(ID), 0);
        }
    }
    assert_eq!(fx.connections(), 0);
    assert!(fx.events().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn another_plugin_cannot_touch_a_live_stream_or_socket() {
    const B: &str = "com.example.other";
    let fx = NetFixture::new().await;
    let host = FakeHost {
        net: Some(fx.engine()),
        ..FakeHost::default()
    };
    let a = granted(vec![fx.origin()]);
    let b = EnabledSet::only(
        B,
        Serving {
            tier: Tier::Ui,
            version: "1.0.0".into(),
            granted: vec![Capability::Network],
            origins: vec![fx.origin()].into(),
            dev_mode: false,
        },
    );
    let api = ApiState::default();

    let open = json!({ "url": fx.ws_url("/ws") });
    let opened = call(&host, &a, &api, "net.socket.open", open)
        .await
        .unwrap();
    let socket = opened["socket"].as_str().unwrap().to_string();
    let text = json!({ "url": fx.url("/stream"), "stream": true }).to_string();
    let admitted = admit(&a, &api, ID, "net.fetch", text.len(), Instant::now()).unwrap();
    let fetched = fetch(admitted, &text, Vec::new(), fx.engine(), api.net().clone())
        .await
        .unwrap();
    let stream = fetched.result["stream"].as_str().unwrap().to_string();

    for (method, args) in [
        ("net.stream.ack", json!({ "stream": stream, "bytes": 0 })),
        ("net.stream.cancel", json!({ "stream": stream })),
        ("net.socket.send", json!({ "socket": socket, "text": "x" })),
        ("net.socket.close", json!({ "socket": socket })),
    ] {
        let result = call_as(B, &host, &b, &api, method, args).await;
        assert_eq!(code(&result), (ApiCode::NotFound, None), "{method}");
    }

    // A's stream and socket still run.
    let ack = json!({ "stream": stream, "bytes": 0 });
    assert_eq!(
        call(&host, &a, &api, "net.stream.ack", ack).await,
        Ok(json!({}))
    );
    let send = json!({ "socket": socket, "text": "still" });
    assert_eq!(
        call(&host, &a, &api, "net.socket.send", send).await,
        Ok(json!({}))
    );
    let echoed = |p: &Value| p["kind"] == "text" && p["data"] == "still";
    assert!(
        fx.until(|events| events.iter().any(|(_, p)| echoed(p)))
            .await
    );
    let ended = |p: &Value| matches!(p["kind"].as_str(), Some("end" | "error" | "close"));
    assert!(!fx.events().iter().any(|(_, p)| ended(p)));

    let cancel = json!({ "stream": stream });
    assert_eq!(
        call(&host, &a, &api, "net.stream.cancel", cancel).await,
        Ok(json!({}))
    );
    let close = json!({ "socket": socket });
    assert_eq!(
        call(&host, &a, &api, "net.socket.close", close).await,
        Ok(json!({}))
    );
}

#[test]
fn a_key_with_the_reserved_prefix_is_refused_on_fetch_and_abort() {
    let enabled = granted(Vec::new());
    let api = ApiState::default();
    let reserved = json!({ "abort_key": "plisto:stream:-3" });
    let fetch = json!({ "url": "https://a.example/", "abort_key": "plisto:stream:-3" });
    let refused = fetch_args(&args(fetch), Vec::new(), String::new()).err().unwrap();
    assert_eq!(refused.code, ApiCode::InvalidArgs);
    let admitted = admit(&enabled, &api, ID, "net.abort", 2, Instant::now()).unwrap();
    let host = FakeHost::default();
    let aborted = match start(&admitted, &reserved.to_string(), Path::new(""), &host, &api) {
        Started::Done(result) => result,
        Started::Later(_) => panic!("an abort answers at once"),
    };
    assert_eq!(aborted.unwrap_err().code, ApiCode::InvalidArgs);
    // The prefix alone is reserved; a key that only resembles it is the plugin's.
    assert!(abort_key(&args(json!({ "abort_key": "plisto-mine" })))
        .unwrap()
        .is_some());
}
