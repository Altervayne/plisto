/*
 * Plugin WebSockets. The opening handshake is a plain `GET` through the same clients and guarded
 * resolver as a fetch, upgraded once the server answers 101; no redirect is followed. Once open, one
 * driver task owns the connection and is the only one that ends it: a close the plugin asks for, a
 * close from the server, a limit, a cancel (frame gone, stopped) and a dropped connection all end in
 * that task, which then emits the socket's one `close` event and writes its one log entry, even when
 * the driver panics. The socket's cap slot lives in that task too: it is held until the task ends,
 * except that a cancel (frame gone, stopped) frees it at once while the task closes the connection,
 * for at most `CLOSE_GRACE`.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::{FutureExt, SinkExt, StreamExt};
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::Upgraded;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;

// -- Local Imports --
use super::client::Clients;
use super::fetch::{error_text, explain, map_transport_error, unix_ms};
use super::policy::{self, Consent, Target, Transport};
use super::sink::{NetEvent, NetSink, SocketEventKind};
use super::state::{CancelFn, EndReason, Kind, LogKind, NetLogEntry, NetState, Running};
use super::{Refusal, CLOSED, HANDSHAKE, PLISTO_LIMIT, PROTOCOL};
use crate::plugins::api::error::ApiError;
use crate::plugins::api::state::lock;

pub(super) mod handshake;

// ---- Limits ----

pub const HANDSHAKE_MIN_MS: u64 = 1_000;
pub const HANDSHAKE_MAX_MS: u64 = 30_000;
pub const HANDSHAKE_DEFAULT_MS: u64 = 15_000;
/// Largest `text` (UTF-8 bytes) or binary message a plugin may send.
pub const MAX_SEND: usize = 64 * 1024;
/// Messages waiting to be written, per socket.
pub const SEND_QUEUE: usize = 16;
pub const MAX_CLOSE_REASON: usize = 123;
pub const MAX_INCOMING: usize = 1_048_576;
pub const MAX_INCOMING_PER_SECOND: u32 = 100;
pub const MAX_INCOMING_BYTES_PER_SECOND: usize = 4 * 1_048_576;
/// How long a closing socket waits on the server: to take its close frame, or, when the plugin closes,
/// to take the queued messages and the close and answer with its own close.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

// ---- Close codes ----

const NORMAL: u16 = 1000;
const GOING_AWAY: u16 = 1001;
const POLICY: u16 = 1008;
/// The server's close frame carried no code.
const NO_STATUS: u16 = 1005;
/// The connection ended without a close handshake.
const ABNORMAL: u16 = 1006;

/// A socket open request in the shape the plugin asked for. The URL, protocols and headers are
/// checked in `open`; the timeout comes from `handshake_timeout`.
pub struct SocketRequest {
    pub url: String,
    pub protocols: Vec<String>,
    pub headers: Vec<(String, String)>,
    pub timeout: Duration,
    /// Sent unless the author set a `user-agent`.
    pub user_agent: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SocketOpened {
    /// `"s"` and a process-wide counter.
    pub socket: String,
    /// The protocol the server chose from those offered.
    pub protocol: Option<String>,
}

pub enum Outgoing {
    Text(String),
    Binary(Vec<u8>),
}

/// The handshake deadline for `timeout_ms`: `HANDSHAKE_DEFAULT_MS` when absent.
pub fn handshake_timeout(timeout_ms: Option<u64>) -> Result<Duration, ApiError> {
    let ms = timeout_ms.unwrap_or(HANDSHAKE_DEFAULT_MS);
    if !(HANDSHAKE_MIN_MS..=HANDSHAKE_MAX_MS).contains(&ms) {
        return Err(ApiError::invalid_args(
            "The socket timeout is out of range.",
        ));
    }
    Ok(Duration::from_millis(ms))
}

// ---- Socket table ----

struct Handle {
    plugin: String,
    outbox: mpsc::Sender<Message>,
    close: oneshot::Sender<CloseFrame>,
}

/// The open sockets by id. Cheap to clone; every clone shares the same table.
#[derive(Clone, Default)]
pub struct Sockets(Arc<Mutex<HashMap<String, Handle>>>);

static SHARED: OnceLock<Sockets> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Sockets {
    pub fn shared() -> &'static Sockets {
        SHARED.get_or_init(Sockets::default)
    }

    fn table(&self) -> MutexGuard<'_, HashMap<String, Handle>> {
        lock(&self.0)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.table().len()
    }
}

/// Queues `message` on plugin `id`'s `socket`. An unknown, closed or foreign socket is `not_found`;
/// a full queue is `busy`.
pub fn send(sockets: &Sockets, id: &str, socket: &str, message: Outgoing) -> Result<(), ApiError> {
    let message = match message {
        Outgoing::Text(text) if text.len() <= MAX_SEND => Message::text(text),
        Outgoing::Binary(bytes) if bytes.len() <= MAX_SEND => Message::binary(bytes),
        _ => return Err(ApiError::invalid_args("The message is too large.")),
    };
    let table = sockets.table();
    let handle = table
        .get(socket)
        .filter(|h| h.plugin == id)
        .ok_or_else(ApiError::not_found)?;
    handle
        .outbox
        .try_send(message)
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => ApiError::busy(),
            mpsc::error::TrySendError::Closed(_) => ApiError::not_found(),
        })
}

/// Starts closing plugin `id`'s `socket` with `code` (1000 or 3000-4999, default 1000) and `reason`.
/// Messages already queued are written first. The socket is gone from the table at once.
pub fn close(
    sockets: &Sockets,
    id: &str,
    socket: &str,
    code: Option<u16>,
    reason: &str,
) -> Result<(), ApiError> {
    let code = code.unwrap_or(NORMAL);
    if !(code == NORMAL || (3000..=4999).contains(&code)) {
        return Err(ApiError::invalid_args("The close code is not allowed."));
    }
    if reason.len() > MAX_CLOSE_REASON {
        return Err(ApiError::invalid_args("The close reason is too long."));
    }
    let mut table = sockets.table();
    if table.get(socket).is_none_or(|h| h.plugin != id) {
        return Err(ApiError::not_found());
    }
    if let Some(handle) = table.remove(socket) {
        let _ = handle.close.send(close_frame(code, reason));
    }
    Ok(())
}

fn close_frame(code: u16, reason: &str) -> CloseFrame {
    CloseFrame {
        code: CloseCode::from(code),
        reason: reason.into(),
    }
}

// ---- Opening ----

type Ws = WebSocketStream<Upgraded>;

/// Opens a socket for plugin `id` and starts its driver, which reports through `sink`. The socket
/// holds a socket slot from the first check until its driver ends, or until a cancel frees it.
pub async fn open(
    clients: &Clients,
    net: &NetState,
    sockets: &Sockets,
    sink: Arc<dyn NetSink>,
    id: &str,
    consent: Consent<'_>,
    request: SocketRequest,
) -> Result<SocketOpened, ApiError> {
    let (end_tx, mut ended) = oneshot::channel::<EndReason>();
    // Only signals: the driver, or the pending handshake, drops the connection when it wakes.
    let cancel: CancelFn = Box::new(move |why| {
        let _ = end_tx.send(why);
    });
    let running = net.open(id, Kind::Socket, None, cancel)?;
    let target = policy::check_url(&request.url, Transport::Socket, consent)?;

    let started = Instant::now();
    let mut entry = NetLogEntry::new(LogKind::Socket, "GET", &target.url, unix_ms());
    let mut cause = None;
    let handshake = async {
        let mut failed = None;
        let connect = connect(clients, &target, &request, &mut entry, &mut failed);
        let done = tokio::time::timeout(request.timeout, connect)
            .await
            .unwrap_or_else(|_| Err(ApiError::timeout()));
        match (done, failed) {
            // Past the deadline: a discovery wait never turns a failure into `timeout`.
            (Err(error), Some(url)) => Err(explain(clients, error, &url, &mut cause).await),
            (done, _) => done,
        }
    };
    let opening = tokio::select! {
        biased;
        why = &mut ended => Err(ended_error(why)),
        done = handshake => done,
    };
    let (ws, protocol) = match opening {
        Ok(opened) => opened,
        Err(error) => {
            entry.error = Some(error_text(&error, cause));
            entry.ms = started.elapsed().as_millis() as u64;
            net.record(id, entry);
            return Err(error);
        }
    };

    let socket = format!("s{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let (outbox, queued) = mpsc::channel(SEND_QUEUE);
    let (close_tx, close_rx) = oneshot::channel();
    sockets.table().insert(
        socket.clone(),
        Handle {
            plugin: id.to_string(),
            outbox,
            close: close_tx,
        },
    );
    let link = Link {
        id: id.to_string(),
        socket: socket.clone(),
        sockets: sockets.clone(),
        net: net.clone(),
        sink,
        entry,
        started,
        _running: running,
    };
    let signals = Signals {
        ended,
        close: Some(close_rx),
        queued,
    };
    tokio::spawn(async move {
        let mut link = link;
        let run = AssertUnwindSafe(drive(ws, &mut link, signals)).catch_unwind();
        // A panicking driver has dropped the connection while unwinding; its socket still ends.
        let end = run
            .await
            .unwrap_or_else(|_| End::dropped(Refusal::network(CLOSED).into()));
        link.finish(end);
    });
    Ok(SocketOpened { socket, protocol })
}

fn ended_error(why: Result<EndReason, oneshot::error::RecvError>) -> ApiError {
    why.ok()
        .and_then(EndReason::error)
        .unwrap_or_else(|| Refusal::network(CLOSED).into())
}

/// The handshake: checks, the upgrade request, the 101 answer, then the frame codec over the
/// upgraded connection. A transport failure leaves its URL in `failed`, for the caller to explain
/// past the deadline. Dropping this future drops the connection.
async fn connect(
    clients: &Clients,
    target: &Target,
    request: &SocketRequest,
    entry: &mut NetLogEntry,
    failed: &mut Option<tauri::Url>,
) -> Result<(Ws, Option<String>), ApiError> {
    let headers = policy::check_headers(&request.headers)?;
    handshake::check_protocols(&request.protocols)?;
    let url = policy::upgrade_url(&target.url).ok_or(Refusal::network(HANDSHAKE))?;
    let client = clients.get(target.kind)?;

    let key = handshake::new_key().ok_or(Refusal::network(HANDSHAKE))?;
    let mut builder = client.get(url.clone());
    for (name, value) in policy::outgoing_headers(headers, &request.user_agent) {
        builder = builder.header(name, value);
    }
    let mut upgrade = vec![
        ("connection", "upgrade".to_string()),
        ("upgrade", "websocket".to_string()),
        ("sec-websocket-version", "13".to_string()),
        ("sec-websocket-key", key.clone()),
    ];
    if !request.protocols.is_empty() {
        upgrade.push(("sec-websocket-protocol", request.protocols.join(", ")));
    }
    for (name, value) in upgrade {
        let value = HeaderValue::from_str(&value).map_err(|_| Refusal::network(HANDSHAKE))?;
        builder = builder.header(HeaderName::from_static(name), value);
    }

    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            *failed = Some(url);
            return Err(map_transport_error(&error));
        }
    };
    entry.status = Some(response.status().as_u16());
    if response.status().as_u16() != 101 {
        return Err(Refusal::network(HANDSHAKE).into());
    }
    let protocol = handshake::check_answer(response.headers(), &key, &request.protocols)?;
    let upgraded = match response.upgrade().await {
        Ok(upgraded) => upgraded,
        Err(error) => {
            *failed = Some(url);
            return Err(map_transport_error(&error));
        }
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_INCOMING))
        .max_frame_size(Some(MAX_INCOMING));
    let ws = WebSocketStream::from_raw_socket(upgraded, Role::Client, Some(config)).await;
    Ok((ws, protocol))
}

// ---- Driver ----

/// What the driver owns besides the connection. Dropping it frees the socket slot.
struct Link {
    id: String,
    socket: String,
    sockets: Sockets,
    net: NetState,
    sink: Arc<dyn NetSink>,
    entry: NetLogEntry,
    started: Instant,
    _running: Running,
}

struct Signals {
    ended: oneshot::Receiver<EndReason>,
    /// Taken once it has answered.
    close: Option<oneshot::Receiver<CloseFrame>>,
    queued: mpsc::Receiver<Message>,
}

/// The close the plugin asked for; never resolves once the signal has answered.
async fn close_asked(close: &mut Option<oneshot::Receiver<CloseFrame>>) -> Option<CloseFrame> {
    let Some(receiver) = close.as_mut() else {
        return std::future::pending().await;
    };
    let frame = receiver.await.ok();
    *close = None;
    frame
}

/// How a socket ended: its `close` event, and the error its log entry keeps (none for a completed
/// close handshake).
struct End {
    code: u16,
    reason: String,
    clean: bool,
    error: Option<ApiError>,
}

impl End {
    fn dropped(error: ApiError) -> End {
        End {
            code: ABNORMAL,
            reason: String::new(),
            clean: false,
            error: Some(error),
        }
    }

    /// The close handshake completed with the server's `frame`.
    fn completed(frame: Option<CloseFrame>) -> End {
        let (code, reason) = match frame {
            Some(frame) => (u16::from(frame.code), frame.reason.as_str().to_string()),
            None => (NO_STATUS, String::new()),
        };
        End {
            code,
            reason,
            clean: true,
            error: None,
        }
    }
}

/// Incoming traffic in the current one-second window.
struct Meter {
    window: Instant,
    messages: u32,
    bytes: usize,
}

impl Meter {
    fn new(now: Instant) -> Meter {
        Meter {
            window: now,
            messages: 0,
            bytes: 0,
        }
    }

    /// Counts one message of `len` bytes; false once the window is past either limit.
    fn admit(&mut self, len: usize, now: Instant) -> bool {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            *self = Meter::new(now);
        }
        self.messages += 1;
        self.bytes += len;
        self.messages <= MAX_INCOMING_PER_SECOND && self.bytes <= MAX_INCOMING_BYTES_PER_SECOND
    }
}

/// Runs the socket until it ends, and says how.
async fn drive(mut ws: Ws, link: &mut Link, mut signals: Signals) -> End {
    let mut meter = Meter::new(Instant::now());
    let mut queue_done = false;
    loop {
        tokio::select! {
            biased;
            why = &mut signals.ended => break abandon(&mut ws, why).await,
            Some(frame) = close_asked(&mut signals.close) => {
                break close_now(&mut ws, link, &mut signals, frame).await;
            }
            message = signals.queued.recv(), if !queue_done => match message {
                // A write to a server that stops reading must not hold off a cancel or a close.
                Some(message) => tokio::select! {
                    biased;
                    why = &mut signals.ended => break abandon(&mut ws, why).await,
                    Some(frame) = close_asked(&mut signals.close) => {
                        break close_now(&mut ws, link, &mut signals, frame).await;
                    }
                    written = write(&mut ws, link, message) => {
                        if let Err(error) = written {
                            break End::dropped(error);
                        }
                    }
                },
                None => queue_done = true,
            },
            incoming = ws.next() => {
                let message = match incoming {
                    Some(Ok(message)) => message,
                    Some(Err(WsError::Capacity(_))) => break over_limit(&mut ws).await,
                    Some(Err(error)) => break End::dropped(ws_error(&error)),
                    None => break End::dropped(Refusal::network(CLOSED).into()),
                };
                let len = match &message {
                    Message::Text(text) => text.len(),
                    Message::Binary(bytes) => bytes.len(),
                    Message::Close(frame) => break closed_by_server(&mut ws, frame.clone()).await,
                    _ => continue,
                };
                link.entry.received += len as u64;
                if !meter.admit(len, Instant::now()) {
                    break over_limit(&mut ws).await;
                }
                link.deliver(message);
            }
        }
    }
}

/// The plugin's close, bounded by `CLOSE_GRACE` and still ended at once by a cancel.
async fn close_now(ws: &mut Ws, link: &mut Link, signals: &mut Signals, frame: CloseFrame) -> End {
    let closing = close_by_us(ws, link, &mut signals.queued, frame);
    match unless_ended(&mut signals.ended, closing).await {
        Ok(end) => end,
        Err(why) => abandon(ws, why).await,
    }
}

impl Link {
    fn deliver(&self, message: Message) {
        let kind = match message {
            Message::Text(text) => SocketEventKind::Text {
                data: text.as_str().to_string(),
            },
            Message::Binary(bytes) => SocketEventKind::Binary {
                data_b64: STANDARD.encode(&bytes),
            },
            _ => return,
        };
        self.sink
            .emit(NetEvent::socket(&self.id, &self.socket, kind));
    }

    /// Takes the socket out of the table, writes its log entry and emits its `close`. Dropping the
    /// link afterwards frees the slot.
    fn finish(mut self, end: End) {
        self.sockets.table().remove(&self.socket);
        self.entry.error = end.error.as_ref().map(|error| error_text(error, None));
        self.entry.ms = self.started.elapsed().as_millis() as u64;
        self.net.record(&self.id, self.entry.clone());
        let close = SocketEventKind::Close {
            code: end.code,
            reason: end.reason,
            clean: end.clean,
        };
        self.sink
            .emit(NetEvent::socket(&self.id, &self.socket, close));
    }
}

/// Runs `work` unless the socket's entry is ended first.
async fn unless_ended<T>(
    ended: &mut oneshot::Receiver<EndReason>,
    work: impl Future<Output = T>,
) -> Result<T, Result<EndReason, oneshot::error::RecvError>> {
    tokio::select! {
        biased;
        why = ended => Err(why),
        done = work => Ok(done),
    }
}

async fn write(ws: &mut Ws, link: &mut Link, message: Message) -> Result<(), ApiError> {
    let len = message.len() as u64;
    ws.send(message).await.map_err(|error| ws_error(&error))?;
    link.entry.sent += len;
    Ok(())
}

fn ws_error(error: &WsError) -> ApiError {
    let reason = match error {
        WsError::Protocol(_) | WsError::Utf8(_) => PROTOCOL,
        _ => CLOSED,
    };
    Refusal::network(reason).into()
}

/// Writes a close frame, giving up after `CLOSE_GRACE`. The connection is dropped right after.
async fn send_close(ws: &mut Ws, code: u16, reason: &str) {
    let _ = tokio::time::timeout(CLOSE_GRACE, ws.close(Some(close_frame(code, reason)))).await;
}

/// The plugin's frame went away or the plugin stopped: 1001, without waiting on the server.
async fn abandon(ws: &mut Ws, why: Result<EndReason, oneshot::error::RecvError>) -> End {
    send_close(ws, GOING_AWAY, "").await;
    let error = ended_error(why);
    End {
        code: GOING_AWAY,
        reason: error.reason.unwrap_or_default().to_string(),
        clean: false,
        error: Some(error),
    }
}

/// A message or a rate over the limits: 1008 `plisto_limit`, without reading any further.
async fn over_limit(ws: &mut Ws) -> End {
    send_close(ws, POLICY, PLISTO_LIMIT).await;
    End {
        code: POLICY,
        reason: PLISTO_LIMIT.to_string(),
        clean: false,
        error: Some(Refusal::network(PLISTO_LIMIT).into()),
    }
}

/// Writes what the plugin queued before asking, then the close, then waits for the server's close,
/// all within `CLOSE_GRACE`. Messages that arrive meanwhile are counted, not delivered.
async fn close_by_us(
    ws: &mut Ws,
    link: &mut Link,
    queued: &mut mpsc::Receiver<Message>,
    frame: CloseFrame,
) -> End {
    let answer = tokio::time::timeout(CLOSE_GRACE, async {
        while let Ok(message) = queued.try_recv() {
            write(ws, link, message).await.ok()?;
        }
        ws.close(Some(frame)).await.ok()?;
        while let Some(Ok(message)) = ws.next().await {
            match message {
                Message::Close(frame) => return Some(frame),
                other => link.entry.received += other.len() as u64,
            }
        }
        None
    })
    .await;
    match answer {
        Ok(Some(frame)) => End::completed(frame),
        _ => End::dropped(Refusal::network(CLOSED).into()),
    }
}

/// The server closed: its frame is answered by the codec, then the connection drains for at most
/// `CLOSE_GRACE`.
async fn closed_by_server(ws: &mut Ws, frame: Option<CloseFrame>) -> End {
    let _ = tokio::time::timeout(CLOSE_GRACE, async {
        while let Some(Ok(_)) = ws.next().await {}
    })
    .await;
    End::completed(frame)
}

#[cfg(test)]
mod tests;
