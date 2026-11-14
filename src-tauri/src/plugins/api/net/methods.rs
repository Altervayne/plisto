/*
 * The network methods as the plugin API answers them. Arguments are checked here, in Rust, before the
 * engine sees them, and the engine then runs its own guard. `net.fetch` carries a binary body, so only
 * the raw `plugin_fetch` command serves it: reached through `plugin_call` it is refused. Requests and
 * socket handshakes resolve on the async runtime as later jobs; what a stream or socket receives after
 * that goes to the sink of the engine the host hands over.
 */

// -- Library Imports --
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use tauri::Url;

// -- Local Imports --
use super::client::Clients;
use super::fetch::{self, FetchRequest, RedirectMode};
use super::policy::{self, Consent, Method, ResponseHeaders};
use super::proxy::NetEnvironment;
use super::sink::NetSink;
use super::socket::{self, Outgoing, SocketRequest, Sockets};
use super::state::NetState;
use super::stream::{self, StreamRequest, Streams};
use crate::plugins::api::error::ApiError;
use crate::plugins::api::rate::RateClass;
use crate::plugins::api::{Admitted, CallCtx, MethodSpec, Need, Outcome};
use crate::plugins::manifest::Capability;

/// The `invalid_args` reason of a `net.fetch` that came through `plugin_call`.
pub const WRONG_TRANSPORT: &str = "wrong_transport";
pub const FETCH_TIMEOUT_MIN_MS: u64 = 1_000;
pub const FETCH_TIMEOUT_MAX_MS: u64 = 120_000;
pub const FETCH_TIMEOUT_DEFAULT_MS: u64 = 30_000;
pub const MAX_ABORT_KEY: usize = 64;

const NETWORK: Need = Need::Cap(Capability::Network);

pub(crate) const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "net.fetch",
        need: NETWORK,
        class: RateClass::Net,
        run: wrong_transport,
    },
    MethodSpec {
        name: "net.abort",
        need: NETWORK,
        class: RateClass::NetSend,
        run: abort,
    },
    MethodSpec {
        name: "net.stream.ack",
        need: NETWORK,
        class: RateClass::NetStream,
        run: stream_ack,
    },
    MethodSpec {
        name: "net.stream.cancel",
        need: NETWORK,
        class: RateClass::NetSend,
        run: stream_cancel,
    },
    MethodSpec {
        name: "net.socket.open",
        need: NETWORK,
        class: RateClass::Net,
        run: socket_open,
    },
    MethodSpec {
        name: "net.socket.send",
        need: NETWORK,
        class: RateClass::NetSend,
        run: socket_send,
    },
    MethodSpec {
        name: "net.socket.close",
        need: NETWORK,
        class: RateClass::NetSend,
        run: socket_close,
    },
];

/// What the network methods run on: the HTTP clients, the open streams and sockets, and the sink
/// their later events go to. Cheap to clone.
#[derive(Clone)]
pub struct NetEngine {
    clients: &'static Clients,
    streams: Streams,
    sockets: Sockets,
    sink: Arc<dyn NetSink>,
}

impl NetEngine {
    /// The process-wide engine, reporting through `sink`.
    pub fn shared(sink: Arc<dyn NetSink>) -> NetEngine {
        NetEngine {
            clients: Clients::shared(),
            streams: Streams::shared().clone(),
            sockets: Sockets::shared().clone(),
            sink,
        }
    }
}

/// What Windows says about a proxy, read through the shared clients' cache.
pub fn environment() -> NetEnvironment {
    Clients::shared().proxy().environment()
}

fn engine(ctx: &CallCtx<'_>) -> Result<NetEngine, ApiError> {
    ctx.host.net().ok_or_else(ApiError::unavailable)
}

// ---- Arguments ----

fn given(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

fn string<'a>(
    args: &'a Map<String, Value>,
    name: &str,
    message: &'static str,
) -> Result<&'a str, ApiError> {
    args.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_args(message))
}

/// A non-negative integer, or none when absent or null.
fn optional_u64(
    args: &Map<String, Value>,
    name: &str,
    message: &'static str,
) -> Result<Option<u64>, ApiError> {
    match given(args.get(name)) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| ApiError::invalid_args(message)),
    }
}

/// An object of string to string, in the map's order; the guard checks names and values.
fn headers(args: &Map<String, Value>) -> Result<Vec<(String, String)>, ApiError> {
    let invalid = || ApiError::invalid_args("'headers' must be an object of strings.");
    match given(args.get("headers")) {
        None => Ok(Vec::new()),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(name, value)| match value {
                Value::String(value) => Ok((name.clone(), value.clone())),
                _ => Err(invalid()),
            })
            .collect(),
        Some(_) => Err(invalid()),
    }
}

/// 1 to `MAX_ABORT_KEY` bytes of visible ASCII.
fn abort_key_ok(key: &str) -> bool {
    (1..=MAX_ABORT_KEY).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic())
}

fn abort_key(args: &Map<String, Value>) -> Result<Option<String>, ApiError> {
    match given(args.get("abort_key")) {
        None => Ok(None),
        Some(Value::String(key)) if abort_key_ok(key) => Ok(Some(key.clone())),
        Some(_) => Err(ApiError::invalid_args(
            "'abort_key' must be 1 to 64 visible ASCII characters.",
        )),
    }
}

fn fetch_timeout(args: &Map<String, Value>) -> Result<Duration, ApiError> {
    let message = "'timeout_ms' must be an integer from 1000 to 120000.";
    let ms = optional_u64(args, "timeout_ms", message)?.unwrap_or(FETCH_TIMEOUT_DEFAULT_MS);
    if !(FETCH_TIMEOUT_MIN_MS..=FETCH_TIMEOUT_MAX_MS).contains(&ms) {
        return Err(ApiError::invalid_args(message));
    }
    Ok(Duration::from_millis(ms))
}

fn user_agent(id: &str, version: &str) -> String {
    policy::user_agent(env!("CARGO_PKG_VERSION"), id, version)
}

/// A `net.fetch` in the shape the engine takes.
struct FetchArgs {
    request: FetchRequest,
    stream: bool,
    idle: Duration,
}

fn fetch_args(
    args: &Map<String, Value>,
    body: Vec<u8>,
    user_agent: String,
) -> Result<FetchArgs, ApiError> {
    let url = string(args, "url", "'url' must be a string.")?.to_string();
    let method = match given(args.get("method")) {
        None => Method::Get,
        Some(value) => value.as_str().and_then(Method::parse).ok_or_else(|| {
            ApiError::invalid_args("'method' must be GET, HEAD, POST, PUT, PATCH or DELETE.")
        })?,
    };
    let headers = headers(args)?;
    let redirect = match given(args.get("redirect")).map(Value::as_str) {
        None => RedirectMode::Follow,
        Some(Some("follow")) => RedirectMode::Follow,
        Some(Some("manual")) => RedirectMode::Manual,
        Some(Some("error")) => RedirectMode::Error,
        Some(_) => {
            return Err(ApiError::invalid_args(
                "'redirect' must be \"follow\", \"manual\" or \"error\".",
            ))
        }
    };
    let timeout = fetch_timeout(args)?;
    let stream = match given(args.get("stream")) {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| ApiError::invalid_args("'stream' must be a boolean."))?,
    };
    let idle_ms = optional_u64(args, "idle_ms", "The idle time is out of range.")?;
    let idle = stream::idle_timeout(idle_ms)?;
    if stream && method == Method::Head {
        return Err(ApiError::invalid_args("A HEAD request cannot be streamed."));
    }
    let abort_key = abort_key(args)?;
    policy::check_body(method, body.len())?;
    Ok(FetchArgs {
        request: FetchRequest {
            url,
            method,
            headers,
            body,
            redirect,
            timeout,
            abort_key,
            user_agent,
        },
        stream,
        idle,
    })
}

// ---- Fetch ----

/// The answer to a `net.fetch`: its result, and the response body when it was buffered.
#[derive(Debug)]
pub struct Fetched {
    pub result: Value,
    pub body: Option<Vec<u8>>,
}

/// The result fields every response has; a streamed one adds `stream`.
fn head(status: u16, url: &Url, redirected: bool, headers: ResponseHeaders) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("status".into(), json!(status));
    map.insert("url".into(), json!(url.as_str()));
    map.insert("redirected".into(), json!(redirected));
    map.insert("headers".into(), json!(headers.headers));
    map.insert("set_cookies".into(), json!(headers.set_cookies));
    map
}

/// Runs one `net.fetch` for an admitted call, keeping its in-flight slot until it resolves: a
/// buffered request until its body is read, a streamed one until its headers. `args` is the JSON
/// text of an object and `body` the raw request body. The request registers under the ticket taken
/// at admission, so one admitted before a forget or frame event is refused.
pub async fn fetch(
    admitted: Admitted,
    args: &str,
    body: Vec<u8>,
    engine: NetEngine,
    net: NetState,
) -> Result<Fetched, ApiError> {
    let Ok(Value::Object(args)) = serde_json::from_str::<Value>(args) else {
        return Err(ApiError::invalid_args(
            "The arguments must be a JSON object.",
        ));
    };
    let net = net.bound(admitted.ticket);
    let id = admitted.id.as_str();
    let serving = &admitted.serving;
    let FetchArgs {
        request,
        stream,
        idle,
    } = fetch_args(&args, body, user_agent(id, &serving.version))?;
    let consent = Consent {
        origins: &serving.origins,
        dev_mode: serving.dev_mode,
    };
    if stream {
        let request = StreamRequest {
            fetch: request,
            idle,
        };
        let sink = engine.sink.clone();
        let opened = stream::open(
            engine.clients,
            &net,
            &engine.streams,
            sink,
            id,
            consent,
            request,
        )
        .await?;
        let mut result = head(
            opened.status,
            &opened.url,
            opened.redirected,
            opened.headers,
        );
        result.insert("stream".into(), json!(opened.stream));
        return Ok(Fetched {
            result: Value::Object(result),
            body: None,
        });
    }
    let response = fetch::execute(engine.clients, &net, id, consent, request).await?;
    let result = head(
        response.status,
        &response.url,
        response.redirected,
        response.headers,
    );
    Ok(Fetched {
        result: Value::Object(result),
        body: Some(response.body),
    })
}

fn wrong_transport(_ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    Outcome::Done(Err(ApiError {
        reason: Some(WRONG_TRANSPORT),
        ..ApiError::invalid_args("'net.fetch' is sent through the raw fetch command.")
    }))
}

// ---- Abort and streams ----

fn abort(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(abort_by_key(ctx, args))
}

fn abort_by_key(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let key = abort_key(args)?.ok_or_else(|| {
        ApiError::invalid_args("'abort_key' must be 1 to 64 visible ASCII characters.")
    })?;
    Ok(json!({ "aborted": ctx.api.net().abort(ctx.id, &key) }))
}

fn stream_ack(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(ack(ctx, args))
}

fn ack(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let id = string(args, "stream", "'stream' must be a string.")?;
    let bad_bytes = "'bytes' must be a non-negative integer.";
    let bytes =
        optional_u64(args, "bytes", bad_bytes)?.ok_or_else(|| ApiError::invalid_args(bad_bytes))?;
    stream::ack(&engine(ctx)?.streams, ctx.id, id, bytes)?;
    Ok(json!({}))
}

fn stream_cancel(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(cancel(ctx, args))
}

fn cancel(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let id = string(args, "stream", "'stream' must be a string.")?;
    stream::cancel(&engine(ctx)?.streams, ctx.id, id)?;
    Ok(json!({}))
}

// ---- Sockets ----

fn protocols(args: &Map<String, Value>) -> Result<Vec<String>, ApiError> {
    let invalid = || ApiError::invalid_args("'protocols' must be an array of strings.");
    match given(args.get("protocols")) {
        None => Ok(Vec::new()),
        Some(Value::Array(list)) => list
            .iter()
            .map(|p| p.as_str().map(str::to_string).ok_or_else(invalid))
            .collect(),
        Some(_) => Err(invalid()),
    }
}

fn socket_request(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<SocketRequest, ApiError> {
    let url = string(args, "url", "'url' must be a string.")?.to_string();
    let timeout_ms = optional_u64(args, "timeout_ms", "The socket timeout is out of range.")?;
    Ok(SocketRequest {
        url,
        protocols: protocols(args)?,
        headers: headers(args)?,
        timeout: socket::handshake_timeout(timeout_ms)?,
        user_agent: user_agent(ctx.id, &ctx.serving.version),
    })
}

fn socket_open(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    let (request, engine) = match socket_request(ctx, args).and_then(|r| Ok((r, engine(ctx)?))) {
        Ok(opening) => opening,
        Err(error) => return Outcome::Done(Err(error)),
    };
    let id = ctx.id.to_string();
    let net = ctx.api.net().bound(ctx.ticket);
    let origins = ctx.serving.origins.clone();
    let dev_mode = ctx.serving.dev_mode;
    Outcome::Later(Box::pin(async move {
        let consent = Consent {
            origins: &origins,
            dev_mode,
        };
        let sink = engine.sink.clone();
        let opened = socket::open(
            engine.clients,
            &net,
            &engine.sockets,
            sink,
            &id,
            consent,
            request,
        )
        .await?;
        Ok(json!({ "socket": opened.socket, "protocol": opened.protocol }))
    }))
}

fn socket_send(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(send(ctx, args))
}

fn send(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let socket = string(args, "socket", "'socket' must be a string.")?;
    let message = match (given(args.get("text")), given(args.get("data_b64"))) {
        (Some(Value::String(text)), None) => Outgoing::Text(text.clone()),
        (None, Some(Value::String(data))) => Outgoing::Binary(
            STANDARD
                .decode(data)
                .map_err(|_| ApiError::invalid_args("'data_b64' is not valid base64."))?,
        ),
        _ => {
            return Err(ApiError::invalid_args(
                "Exactly one of 'text' and 'data_b64' must be a string.",
            ))
        }
    };
    socket::send(&engine(ctx)?.sockets, ctx.id, socket, message)?;
    Ok(json!({}))
}

fn socket_close(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(close(ctx, args))
}

fn close(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let socket = string(args, "socket", "'socket' must be a string.")?;
    let bad_code = "The close code is not allowed.";
    let code = optional_u64(args, "code", bad_code)?
        .map(|code| u16::try_from(code).map_err(|_| ApiError::invalid_args(bad_code)))
        .transpose()?;
    let reason = match given(args.get("reason")) {
        None => "",
        Some(Value::String(reason)) => reason.as_str(),
        Some(_) => return Err(ApiError::invalid_args("'reason' must be a string.")),
    };
    socket::close(&engine(ctx)?.sockets, ctx.id, socket, code, reason)?;
    Ok(json!({}))
}

// ---- Test fixture ----

/// An engine against a local test server on 127.0.0.1, whose events are recorded as the host events
/// the main window receives. `A` resolves to 127.0.0.1, which counts as public only here.
#[cfg(test)]
pub(crate) struct NetFixture {
    _ca: super::test_server::TestCa,
    server: super::test_server::TestServer,
    engine: NetEngine,
    events: Arc<HostEvents>,
}

#[cfg(test)]
#[derive(Default)]
struct HostEvents(std::sync::Mutex<Vec<crate::plugins::api::host_event::HostEvent>>);

#[cfg(test)]
impl NetSink for HostEvents {
    fn emit(&self, event: super::sink::NetEvent) {
        let event = crate::plugins::api::host_event::HostEvent::Net(event);
        self.0.lock().unwrap().push(event);
    }
}

#[cfg(test)]
impl NetFixture {
    pub const HOST: &'static str = "a.plisto-fixture.com";

    pub async fn new() -> NetFixture {
        use super::test_server::{ScriptedLookup, TestCa, TestServer};
        use std::net::{IpAddr, Ipv4Addr};

        const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
        fn test_allowed(ip: IpAddr) -> bool {
            ip == LOOPBACK || super::address::allowed(ip)
        }

        let ca = TestCa::new();
        let server = TestServer::tls(&ca, &[NetFixture::HOST]).await;
        let lookup = Arc::new(ScriptedLookup::default());
        lookup.answer(NetFixture::HOST, &[&[LOOPBACK]]);
        let clients = Clients::for_tests(lookup, test_allowed, ca.root());
        let events = Arc::new(HostEvents::default());
        let sink: Arc<dyn NetSink> = events.clone();
        let engine = NetEngine {
            // Leaked: a later job must hold the clients for as long as it runs.
            clients: Box::leak(Box::new(clients)),
            streams: Streams::new(Arc::new(super::proxy::SystemClock)),
            sockets: Sockets::default(),
            sink,
        };
        NetFixture {
            _ca: ca,
            server,
            engine,
            events,
        }
    }

    pub fn engine(&self) -> NetEngine {
        self.engine.clone()
    }

    /// Connections the server accepted so far.
    pub fn connections(&self) -> usize {
        self.server.connections()
    }

    pub fn origin(&self) -> String {
        format!("https://{}:{}", NetFixture::HOST, self.server.port)
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.origin())
    }

    pub fn ws_url(&self, path: &str) -> String {
        format!("wss://{}:{}{path}", NetFixture::HOST, self.server.port)
    }

    /// The events sent so far, each as its event name and payload.
    pub fn events(&self) -> Vec<(&'static str, Value)> {
        use crate::plugins::api::host_event::{HostEvent, EVENT_NET};
        let events = self.events.0.lock().unwrap();
        events
            .iter()
            .map(|event| match event {
                HostEvent::Net(net) => (EVENT_NET, serde_json::to_value(net).unwrap()),
                other => panic!("not a network event: {other:?}"),
            })
            .collect()
    }

    /// Polls until `check` holds on the events, for up to 10 s.
    pub async fn until(&self, check: impl Fn(&[(&'static str, Value)]) -> bool) -> bool {
        for _ in 0..500 {
            if check(&self.events()) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }
}

#[cfg(test)]
mod tests;
