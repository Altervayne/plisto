// The raw framing both ways, admission of a frame, and buffered and streamed requests from request
// bytes to reply bytes against the local test server on 127.0.0.1.

// -- Library Imports --
use serde_json::{json, Value};

// -- Local Imports --
use super::*;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::NetFixture;
use crate::plugins::manifest::{Capability, Tier};
use crate::plugins::state::Serving;

const ID: &str = "com.example.demo";

/// Request bytes as the shim frames them.
fn request(id: &str, args: &str, body: &[u8]) -> Vec<u8> {
    let meta = json!({ "id": id, "args": args }).to_string().into_bytes();
    raw(&meta, body)
}

fn raw(meta: &[u8], body: &[u8]) -> Vec<u8> {
    let mut out = (meta.len() as u32).to_le_bytes().to_vec();
    out.extend_from_slice(meta);
    out.extend_from_slice(body);
    out
}

/// Reads reply bytes as the shim does: the call reply, and the bytes after it.
fn decode(reply: &[u8]) -> (Value, Vec<u8>) {
    let len = u32::from_le_bytes(reply[..4].try_into().unwrap()) as usize;
    let meta = serde_json::from_slice(&reply[4..4 + len]).unwrap();
    (meta, reply[4 + len..].to_vec())
}

fn invalid(result: Result<Frame, ApiError>) -> bool {
    result.err().map(|e| e.code) == Some(ApiCode::InvalidArgs)
}

#[test]
fn a_request_frame_round_trips() {
    let args = json!({ "url": "https://a.example/", "method": "POST" }).to_string();
    let bytes = request(ID, &args, &[0, 1, 255]);
    let frame = frame_from(&bytes).unwrap();
    assert_eq!(frame.id, ID);
    assert_eq!(frame.args, args);
    assert_eq!(frame.body, [0, 1, 255]);
    // No body is an empty one.
    assert!(frame_from(&request(ID, "{}", &[])).unwrap().body.is_empty());
}

#[test]
fn every_malformed_request_is_invalid_args() {
    let meta = json!({ "id": ID, "args": "{}" }).to_string().into_bytes();
    let mut past_end = raw(&meta, &[]);
    past_end[0] += 1;
    let mut huge = raw(&meta, &[]);
    huge[..4].copy_from_slice(&u32::MAX.to_le_bytes());
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", Vec::new()),
        ("short length", vec![1, 0, 0]),
        ("length past the end", past_end),
        ("largest length", huge),
        ("non-UTF-8 JSON", raw(&[b'{', 0xff, 0xfe, b'}'], &[])),
        ("not JSON", raw(b"id=a", &[])),
        ("not an object", raw(b"[\"a\", \"{}\"]", &[])),
        ("missing id", raw(br#"{"args":"{}"}"#, &[])),
        ("missing args", raw(br#"{"id":"com.example.demo"}"#, &[])),
        ("id not a string", raw(br#"{"id":5,"args":"{}"}"#, &[])),
        (
            "args an object",
            raw(br#"{"id":"com.example.demo","args":{}}"#, &[]),
        ),
        (
            "args null",
            raw(br#"{"id":"com.example.demo","args":null}"#, &[]),
        ),
    ];
    for (name, bytes) in cases {
        assert!(invalid(frame_from(&bytes)), "{name}");
    }
}

#[test]
fn replies_frame_a_body_only_after_a_buffered_success() {
    let buffered = Fetched {
        result: json!({ "status": 200 }),
        body: Some(vec![7, 8, 9]),
    };
    let (meta, body) = decode(&reply_bytes(Ok(buffered)));
    assert_eq!(meta, json!({ "ok": true, "result": { "status": 200 } }));
    assert_eq!(body, [7, 8, 9]);

    let streamed = Fetched {
        result: json!({ "status": 200, "stream": "t1" }),
        body: None,
    };
    let (meta, body) = decode(&reply_bytes(Ok(streamed)));
    assert_eq!(meta["result"]["stream"], "t1");
    assert!(body.is_empty());

    let (meta, body) = decode(&reply_bytes(Err(ApiError::denied())));
    assert_eq!(meta["ok"], false);
    assert!(meta["error"]["code"].is_string());
    assert!(body.is_empty());
}

// ---- Admission ----

fn enabled(granted: Vec<Capability>, origins: Vec<String>) -> EnabledSet {
    EnabledSet::only(
        ID,
        Serving {
            tier: Tier::Ui,
            version: "1.0.0".into(),
            granted,
            origins: origins.into(),
            dev_mode: false,
        },
    )
}

/// Serves `bytes` as `plugin_fetch` does, from the webview `label`.
async fn serve(
    fx: &NetFixture,
    enabled: &EnabledSet,
    api: &ApiState,
    label: &str,
    ready: bool,
    bytes: &[u8],
) -> (Value, Vec<u8>) {
    let outcome = answer(frame_from(bytes), label, ready, enabled, api, fx.engine()).await;
    decode(&reply_bytes(outcome))
}

fn error_code(meta: &Value) -> (&str, Option<&str>) {
    assert_eq!(meta["ok"], false, "{meta}");
    (
        meta["error"]["code"].as_str().unwrap(),
        meta["error"]["reason"].as_str(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_is_admitted_as_plugin_call_admits_a_call() {
    let fx = NetFixture::new().await;
    let api = ApiState::default();
    let granted = enabled(vec![Capability::Network], vec![fx.origin()]);
    let bare = enabled(Vec::new(), vec![fx.origin()]);
    let good = request(ID, &json!({ "url": fx.url("/bin") }).to_string(), &[]);
    let bad_args = request(ID, "[]", &[]);

    for label in ["tray", "Main", ""] {
        let (meta, _) = serve(&fx, &granted, &api, label, true, &good).await;
        assert_eq!(error_code(&meta), ("denied", None), "{label:?}");
    }
    // The label is checked before readiness.
    let (meta, _) = serve(&fx, &granted, &api, "tray", false, &good).await;
    assert_eq!(error_code(&meta), ("denied", None));
    let (meta, _) = serve(&fx, &granted, &api, MAIN_LABEL, false, &good).await;
    assert_eq!(error_code(&meta), ("unavailable", None));

    // The frame's plugin must be the serving one.
    let other = request("com.example.other", "{}", &[]);
    let (meta, _) = serve(&fx, &granted, &api, MAIN_LABEL, true, &other).await;
    assert_eq!(error_code(&meta), ("unavailable", None));
    let broken = request("Bad Id", "{}", &[]);
    let (meta, _) = serve(&fx, &granted, &api, MAIN_LABEL, true, &broken).await;
    assert_eq!(error_code(&meta), ("not_found", None));

    // Not granted: denied before any argument is read.
    let (meta, _) = serve(&fx, &bare, &api, MAIN_LABEL, true, &bad_args).await;
    assert_eq!(error_code(&meta), ("denied", None));
    let (meta, _) = serve(&fx, &granted, &api, MAIN_LABEL, true, &bad_args).await;
    assert_eq!(error_code(&meta), ("invalid_args", None));

    // Arguments over the size cap are too large before the grant is checked, as for any call.
    let long = format!("{{\"url\":\"{}\"}}", "a".repeat(api::MAX_ARGS_BYTES));
    let (meta, _) = serve(&fx, &bare, &api, MAIN_LABEL, true, &request(ID, &long, &[])).await;
    assert_eq!(error_code(&meta), ("too_large", None));

    // A malformed frame never reaches admission.
    let (meta, _) = serve(&fx, &granted, &api, MAIN_LABEL, true, &[1, 2]).await;
    assert_eq!(error_code(&meta), ("invalid_args", None));
    assert!(fx.events().is_empty());
}

// ---- End to end ----

#[tokio::test(flavor = "multi_thread")]
async fn a_buffered_fetch_runs_from_request_bytes_to_reply_bytes() {
    let fx = NetFixture::new().await;
    let api = ApiState::default();
    let granted = enabled(vec![Capability::Network], vec![fx.origin()]);

    let get = request(ID, &json!({ "url": fx.url("/bin") }).to_string(), &[]);
    let (meta, body) = serve(&fx, &granted, &api, MAIN_LABEL, true, &get).await;
    assert_eq!(meta["ok"], true, "{meta}");
    let result = &meta["result"];
    assert_eq!(result["status"], 200);
    assert_eq!(result["url"], fx.url("/bin"));
    assert_eq!(result["redirected"], false);
    assert!(result["headers"].is_array());
    assert!(result["set_cookies"].is_array());
    assert!(result.get("stream").is_none());
    assert!(result.get("body").is_none());
    let expected: Vec<u8> = (0..256 * 1024).map(|i| (i % 251) as u8).collect();
    assert_eq!(body, expected);

    let sent: Vec<u8> = (0..=255).collect();
    let post = json!({ "url": fx.url("/echo"), "method": "POST" }).to_string();
    let (meta, body) = serve(
        &fx,
        &granted,
        &api,
        MAIN_LABEL,
        true,
        &request(ID, &post, &sent),
    )
    .await;
    assert_eq!(meta["result"]["status"], 200);
    assert_eq!(body, sent);

    // A body past 1 MiB is refused whole.
    let big = vec![0; 1_048_577];
    let (meta, body) = serve(
        &fx,
        &granted,
        &api,
        MAIN_LABEL,
        true,
        &request(ID, &post, &big),
    )
    .await;
    assert_eq!(error_code(&meta), ("too_large", Some("request_body")));
    assert!(body.is_empty());

    // An unlisted origin is denied with its reason.
    let away = json!({ "url": "https://b.plisto-fixture.com/" }).to_string();
    let (meta, _) = serve(
        &fx,
        &granted,
        &api,
        MAIN_LABEL,
        true,
        &request(ID, &away, &[]),
    )
    .await;
    assert_eq!(error_code(&meta), ("denied", Some("origin_not_listed")));

    // The log holds the origin of each request sent, for the main window only; refused arguments
    // never reached the engine.
    let log = log_from(MAIN_LABEL, &api, ID);
    assert_eq!(log.len(), 2);
    assert!(log.iter().all(|entry| entry.origin() == fx.origin()));
    assert!(log_from("tray", &api, ID).is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_streamed_fetch_answers_the_head_and_streams_the_body_as_events() {
    let fx = NetFixture::new().await;
    let api = ApiState::default();
    let granted = enabled(vec![Capability::Network], vec![fx.origin()]);

    let args = json!({ "url": fx.url("/bin"), "stream": true }).to_string();
    let (meta, body) = serve(
        &fx,
        &granted,
        &api,
        MAIN_LABEL,
        true,
        &request(ID, &args, &[]),
    )
    .await;
    assert_eq!(meta["ok"], true, "{meta}");
    assert!(body.is_empty());
    let stream = meta["result"]["stream"].as_str().unwrap().to_string();
    assert_eq!(meta["result"]["status"], 200);
    assert!(meta["result"]["headers"].is_array());

    let ended = |p: &Value| p["kind"] == "end" || p["kind"] == "error";
    assert!(
        fx.until(|events| events.iter().any(|(_, p)| ended(p)))
            .await
    );
    let events = fx.events();
    assert!(events
        .iter()
        .all(|(name, p)| *name == "plugins:net" && p["stream"] == stream));
    let (last, chunks) = events.split_last().unwrap();
    assert_eq!(last.1, json!({ "id": ID, "stream": stream, "kind": "end" }));
    let mut received = Vec::new();
    for (at, (_, chunk)) in chunks.iter().enumerate() {
        assert_eq!(chunk["kind"], "chunk");
        assert_eq!(chunk["seq"], at as u64 + 1);
        let data = chunk["data_b64"].as_str().unwrap();
        received.extend(
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).unwrap(),
        );
    }
    let expected: Vec<u8> = (0..256 * 1024).map(|i| (i % 251) as u8).collect();
    assert_eq!(received, expected);

    // A response without a body has no stream.
    let none = json!({ "url": fx.url("/status/204"), "stream": true }).to_string();
    let (meta, _) = serve(
        &fx,
        &granted,
        &api,
        MAIN_LABEL,
        true,
        &request(ID, &none, &[]),
    )
    .await;
    assert_eq!(meta["result"]["status"], 204);
    assert_eq!(meta["result"]["stream"], Value::Null);
}

#[test]
fn the_environment_is_read_for_the_main_window_only() {
    let manual = || NetEnvironment {
        proxy: ProxyKind::Manual,
    };
    let read = environment_from(MAIN_LABEL, manual);
    assert_eq!(
        serde_json::to_value(read).unwrap(),
        json!({ "proxy": "manual" })
    );
    for label in ["tray", "Main", ""] {
        let read = environment_from(label, || panic!("read for {label:?}"));
        assert_eq!(
            serde_json::to_value(read).unwrap(),
            json!({ "proxy": "none" })
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_args_size_is_measured_as_plugin_call_measures_it() {
    let fx = NetFixture::new().await;
    let granted = enabled(vec![Capability::Network], vec![fx.origin()]);
    // Each quote doubles in the framed JSON, so the frame is far past the cap while the args are not.
    let quoted = |len: usize| {
        let head = "{\"q\":\"";
        let fill = "\\\"".repeat((len - head.len() - 2) / 2);
        let text = format!("{head}{fill}\"}}");
        assert_eq!(text.len(), len);
        text
    };
    for (len, expected) in [
        (api::MAX_ARGS_BYTES, "invalid_args"),
        (api::MAX_ARGS_BYTES + 2, "too_large"),
    ] {
        let args = quoted(len);
        let api = ApiState::default();
        let bytes = request(ID, &args, &[]);
        assert!(bytes.len() > 2 * api::MAX_ARGS_BYTES);
        let (meta, _) = serve(&fx, &granted, &api, MAIN_LABEL, true, &bytes).await;
        assert_eq!(error_code(&meta).0, expected, "{len}");
        // `plugin_call` admits the same args the same way.
        let admitted = call_from(
            MAIN_LABEL,
            true,
            &granted,
            &api,
            ID,
            "net.fetch",
            args.len(),
            Instant::now(),
        );
        assert_eq!(admitted.is_ok(), expected == "invalid_args", "{len}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_from_another_window_is_refused_whatever_its_shape() {
    let fx = NetFixture::new().await;
    let api = ApiState::default();
    let granted = enabled(vec![Capability::Network], vec![fx.origin()]);
    let good = request(ID, &json!({ "url": fx.url("/bin") }).to_string(), &[]);
    for label in ["tray", "nowplaying"] {
        let (meta, body) = serve(&fx, &granted, &api, label, true, &good).await;
        assert_eq!(error_code(&meta), ("denied", None), "{label}");
        assert!(body.is_empty());
        // The id is inside the frame, so a malformed one is refused before the label is read.
        let (meta, body) = serve(&fx, &granted, &api, label, true, &[9, 0, 0, 0, b'{']).await;
        assert_eq!(error_code(&meta), ("invalid_args", None), "{label}");
        assert!(body.is_empty());
    }
    assert_eq!(fx.connections(), 0);
    assert!(log_from(MAIN_LABEL, &api, ID).is_empty());
}
