/*
 * Plugin WebSockets. The opening handshake is a plain `GET` through the same clients and guarded
 * resolver as a fetch, upgraded once the server answers 101; no redirect is followed. Once open, one
 * driver task owns the connection and is the only one that ends it: a close the plugin asks for, a
 * close from the server, a limit, a cancel (frame gone, stopped) and a dropped connection all end in
 * that task, which then emits the socket's one `close` event and writes its one log entry, even when
 * the driver panics. The socket's cap slot lives in that task too: it is held until the task ends,
 * except that a cancel (frame gone, stopped) frees it at once while the task closes the connection,
 * for at most `CLOSE_GRACE`.
 *
 * Incoming messages are paced by the page: once `SOCKET_WINDOW` payload bytes are delivered and not
 * acknowledged, the driver stops reading, so TCP slows the server and nothing piles up towards a slow
 * main window. Pings are not answered while reads wait, since they sit behind the unread messages. A
 * full window with no acknowledgement for `STALL_MS`, on an injected clock, closes the socket.
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
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::time::Instant as TokioInstant;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::WebSocketStream;

// -- Local Imports --
use self::driver::{drive, End, Link, Signals};
use super::client::Clients;
use super::fetch::{error_text, explain, map_transport_error, unix_ms};
use super::policy::{self, Consent, Target, Transport};
use super::proxy::{Clock, SystemClock};
use super::sink::{NetEvent, NetSink, SocketEventKind};
use super::state::{CancelFn, EndReason, Kind, LogKind, NetLogEntry, NetState, Running};
use super::stream::STALL_MS;
use super::{Refusal, CLOSED, HANDSHAKE, PLISTO_LIMIT, PLISTO_STALLED, PROTOCOL};
use crate::plugins::api::error::ApiError;
use crate::plugins::api::state::lock;

mod driver;
pub(super) mod handshake;

// ---- Limits ----

/// The shortest, longest and default handshake time a plugin may ask for.
pub const HANDSHAKE_MIN_MS: u64 = 1_000;
pub const HANDSHAKE_MAX_MS: u64 = 30_000;
pub const HANDSHAKE_DEFAULT_MS: u64 = 15_000;
/// Largest `text` (UTF-8 bytes) or binary message a plugin may send.
pub const MAX_SEND: usize = 64 * 1024;
/// Messages waiting to be written, per socket.
pub const SEND_QUEUE: usize = 16;
/// A close frame's payload holds 125 bytes; the code takes 2.
pub const MAX_CLOSE_REASON: usize = 123;
/// Largest incoming message, in bytes.
pub const MAX_INCOMING: usize = 1_048_576;
/// Incoming messages and bytes in one second past which the socket closes `plisto_limit`.
pub const MAX_INCOMING_PER_SECOND: u32 = 100;
pub const MAX_INCOMING_BYTES_PER_SECOND: usize = 4 * 1_048_576;
/// Incoming payload bytes delivered and not yet acknowledged at which reading waits. A message at the
/// incoming limit always fits once the page has caught up, with room for smaller ones behind it.
pub const SOCKET_WINDOW: u64 = 2 * 1_048_576;
/// The longest a waiting driver sleeps before it checks for a stall again.
const TICK: Duration = Duration::from_millis(250);
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

struct Credit {
    sent: u64,
    acked: u64,
    /// The last acknowledgement that moved `acked`, or when data began waiting on the page.
    progress_at: Instant,
}

/// What a socket's driver and its `ack` calls share.
struct Window {
    credit: Mutex<Credit>,
    acked: Notify,
    /// Stall checks the waiting driver ran so far.
    #[cfg(test)]
    checks: AtomicU64,
}

impl Window {
    fn new(now: Instant) -> Window {
        Window {
            credit: Mutex::new(Credit {
                sent: 0,
                acked: 0,
                progress_at: now,
            }),
            acked: Notify::new(),
            #[cfg(test)]
            checks: AtomicU64::new(0),
        }
    }

    #[cfg(test)]
    fn checked(&self) {
        self.checks.fetch_add(1, Ordering::Relaxed);
    }

    #[cfg(not(test))]
    fn checked(&self) {}

    fn full(&self) -> bool {
        let credit = lock(&self.credit);
        credit.sent - credit.acked >= SOCKET_WINDOW
    }

    /// Whether data has waited on the page for `STALL_MS` with no acknowledgement.
    fn stalled(&self, now: Instant) -> bool {
        let credit = lock(&self.credit);
        credit.sent > credit.acked
            && now.saturating_duration_since(credit.progress_at) >= Duration::from_millis(STALL_MS)
    }

    fn delivered(&self, len: u64, now: Instant) {
        let mut credit = lock(&self.credit);
        if credit.sent == credit.acked {
            credit.progress_at = now;
        }
        credit.sent += len;
    }
}

struct Handle {
    plugin: String,
    outbox: mpsc::Sender<Message>,
    close: oneshot::Sender<CloseFrame>,
    window: Arc<Window>,
}

/// The open sockets by id, and the clock their stall check reads. Cheap to clone; every clone shares
/// the same table.
#[derive(Clone)]
pub struct Sockets {
    table: Arc<Mutex<HashMap<String, Handle>>>,
    clock: Arc<dyn Clock>,
}

impl Default for Sockets {
    fn default() -> Sockets {
        Sockets::new(Arc::new(SystemClock))
    }
}

static SHARED: OnceLock<Sockets> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Sockets {
    pub fn shared() -> &'static Sockets {
        SHARED.get_or_init(Sockets::default)
    }

    pub fn new(clock: Arc<dyn Clock>) -> Sockets {
        Sockets {
            table: Arc::default(),
            clock,
        }
    }

    fn table(&self) -> MutexGuard<'_, HashMap<String, Handle>> {
        lock(&self.table)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.table().len()
    }

    /// The stall checks `socket`'s waiting driver ran; none once it is gone.
    #[cfg(test)]
    fn checks(&self, socket: &str) -> u64 {
        let table = self.table();
        table
            .get(socket)
            .map_or(0, |h| h.window.checks.load(Ordering::Relaxed))
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

/// Records that plugin `id`'s page consumed `bytes` of `socket`'s incoming payload in all. An unknown,
/// closed or foreign socket is `not_found`; a count below the last one or above what was delivered is
/// `invalid_args`.
pub fn ack(sockets: &Sockets, id: &str, socket: &str, bytes: u64) -> Result<(), ApiError> {
    let window = sockets
        .table()
        .get(socket)
        .filter(|h| h.plugin == id)
        .map(|h| h.window.clone())
        .ok_or_else(ApiError::not_found)?;
    let mut credit = lock(&window.credit);
    if bytes < credit.acked || bytes > credit.sent {
        return Err(ApiError::invalid_args(
            "The acknowledged byte count is out of range.",
        ));
    }
    if bytes > credit.acked {
        credit.acked = bytes;
        credit.progress_at = sockets.clock.now();
    }
    drop(credit);
    window.acked.notify_one();
    Ok(())
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
            (Err(error), Some(url)) => Err(explain(clients.proxy(), error, &url, &mut cause).await),
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
    let window = Arc::new(Window::new(sockets.clock.now()));
    sockets.table().insert(
        socket.clone(),
        Handle {
            plugin: id.to_string(),
            outbox,
            close: close_tx,
            window: window.clone(),
        },
    );
    let link = Link {
        id: id.to_string(),
        socket: socket.clone(),
        sockets: sockets.clone(),
        net: net.clone(),
        sink,
        window,
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

#[cfg(test)]
mod tests;
