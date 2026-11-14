/*
 * Streamed plugin responses read by the plugin's page. The call resolves at the headers; one reader
 * task then owns the connection and is the only one that ends the stream. It emits the body as
 * numbered chunks, never more than `STREAM_WINDOW` past what the page acknowledged, and keeps at most
 * `STREAM_BUFFER` of what it read and could not emit yet: past that it stops reading, so TCP slows
 * the server and memory stays flat however long the stream runs. Nothing is dropped.
 *
 * The idle and stall timers read an injected clock and are checked on every wake and at least once
 * per `TICK`. A chunk waits until a full `STREAM_CHUNK` is ready or its oldest byte has waited
 * `STREAM_COALESCE`, so a server sending tiny pieces costs at most one event per interval; the
 * reader sleeps on a real timer until that deadline, which itself reads the clock.
 *
 * A stream ends once: complete, idle, stalled, cancelled (cancel, abort key, frame gone, stopped)
 * or failed on the wire. Its task then writes its one log entry and emits its one `end` or
 * `error` event, even when the reader panics.
 */

// -- Library Imports --
use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::FutureExt;
use tokio::sync::Notify;

// -- Local Imports --
use super::client::Clients;
use super::fetch::{
    explain, map_transport_error, open_streamed, FetchRequest, StreamBody, StreamHead,
};
use super::policy::{Consent, Method, ResponseHeaders};
use super::proxy::{Clock, Proxy, SystemClock};
use super::sink::{NetEvent, NetSink, StreamEventKind};
use super::state::{EndReason, NetState, StreamKind};
use super::{Refusal, CLOSED, IDLE, STALLED};
use crate::plugins::api::error::ApiError;
use crate::plugins::api::state::lock;

// ---- Limits ----

/// Largest chunk event, in bytes of body.
pub const STREAM_CHUNK: usize = 64 * 1024;
/// Bytes emitted and not yet acknowledged, at most.
pub const STREAM_WINDOW: u64 = 1_048_576;
/// Bytes read and not yet emitted before reading stops.
pub const STREAM_BUFFER: usize = 4 * 1_048_576;
/// How long data may wait on a page that acknowledges nothing.
pub const STALL_MS: u64 = 60_000;
pub const IDLE_MIN_MS: u64 = 5_000;
pub const IDLE_MAX_MS: u64 = 600_000;
pub const IDLE_DEFAULT_MS: u64 = 60_000;
/// The longest a byte waits for a full chunk before it is emitted in a smaller one.
pub const STREAM_COALESCE: Duration = Duration::from_millis(10);
/// The longest a reader sleeps before it checks its timers again.
const TICK: Duration = Duration::from_millis(250);
/// Bytes read within this of a mark share its read time.
const MARK_SPACING: Duration = Duration::from_millis(1);
/// Read-time marks kept per stream; past this, new bytes join the newest mark and count as older,
/// which only emits them sooner.
const MAX_MARKS: usize = 64;
/// The idle time for `idle_ms`: `IDLE_DEFAULT_MS` when absent.
pub fn idle_timeout(idle_ms: Option<u64>) -> Result<Duration, ApiError> {
    let ms = idle_ms.unwrap_or(IDLE_DEFAULT_MS);
    if !(IDLE_MIN_MS..=IDLE_MAX_MS).contains(&ms) {
        return Err(ApiError::invalid_args("The idle time is out of range."));
    }
    Ok(Duration::from_millis(ms))
}

/// `timeout` / `idle`: the stream received no byte for its idle time.
pub fn idle_error() -> ApiError {
    ApiError {
        reason: Some(IDLE),
        ..ApiError::timeout()
    }
}

pub struct StreamRequest {
    /// Its `timeout` runs until the headers.
    pub fetch: FetchRequest,
    /// Ends the stream once no byte arrived for this long; from `idle_timeout`.
    pub idle: Duration,
}

#[derive(Debug)]
pub struct StreamOpened {
    pub status: u16,
    pub url: tauri::Url,
    pub redirected: bool,
    pub headers: ResponseHeaders,
    /// `"t"` and a process-wide counter; none for a response without a body.
    pub stream: Option<String>,
}

// ---- Stream table ----

struct Credit {
    sent: u64,
    acked: u64,
    /// The last acknowledgement that moved `acked`, or when data began waiting on the page.
    progress_at: Instant,
}

/// What a stream's reader and its `ack` calls share.
struct Window {
    credit: Mutex<Credit>,
    acked: Notify,
    #[cfg(test)]
    probe: Mutex<Probe>,
}

/// What the reader holds, as tests see it.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub struct Probe {
    /// Timer checks run so far.
    pub checks: u64,
    pub buffered: usize,
    pub peak_buffered: usize,
    /// The largest allocation the buffer reached.
    pub peak_capacity: usize,
}

struct Handle {
    plugin: String,
    window: Arc<Window>,
    net: NetState,
    /// The stream's `NetState` entry.
    key: u64,
}

/// The open page streams by id, and the clock their timers read. Cheap to clone; every clone shares
/// the same table.
#[derive(Clone)]
pub struct Streams {
    table: Arc<Mutex<HashMap<String, Handle>>>,
    clock: Arc<dyn Clock>,
}

static SHARED: OnceLock<Streams> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Streams {
    pub fn shared() -> &'static Streams {
        SHARED.get_or_init(|| Streams::new(Arc::new(SystemClock)))
    }

    pub fn new(clock: Arc<dyn Clock>) -> Streams {
        Streams {
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

    #[cfg(test)]
    fn probe(&self, stream: &str) -> Option<Probe> {
        let table = self.table();
        table.get(stream).map(|h| *lock(&h.window.probe))
    }
}

/// Records that plugin `id`'s page consumed `bytes` of `stream` in all. An unknown, ended or foreign
/// stream is `not_found`; a count below the last one or above what was sent is `invalid_args`.
pub fn ack(streams: &Streams, id: &str, stream: &str, bytes: u64) -> Result<(), ApiError> {
    let window = streams
        .table()
        .get(stream)
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
        credit.progress_at = streams.clock.now();
    }
    drop(credit);
    window.acked.notify_one();
    Ok(())
}

/// Ends plugin `id`'s `stream` with `aborted` / `abort`. The stream is gone from the table at once.
pub fn cancel(streams: &Streams, id: &str, stream: &str) -> Result<(), ApiError> {
    let handle = {
        let mut table = streams.table();
        if table.get(stream).is_none_or(|h| h.plugin != id) {
            return Err(ApiError::not_found());
        }
        table.remove(stream)
    };
    if let Some(handle) = handle {
        handle.net.end(handle.key, EndReason::Abort);
    }
    Ok(())
}

// ---- Opening ----

/// Sends a streamed request for plugin `id` and resolves at the headers. A body is then read by its
/// own task, which reports through `sink`. `HEAD` is refused: it has no body to stream.
pub async fn open(
    clients: &Clients,
    net: &NetState,
    streams: &Streams,
    sink: Arc<dyn NetSink>,
    id: &str,
    consent: Consent<'_>,
    request: StreamRequest,
) -> Result<StreamOpened, ApiError> {
    if request.fetch.method == Method::Head {
        return Err(ApiError::invalid_args("A HEAD request cannot be streamed."));
    }
    let head = open_streamed(clients, net, id, consent, &request.fetch, StreamKind::Page).await?;
    let StreamHead {
        status,
        url,
        redirected,
        headers,
        body,
    } = head;
    let stream = body.map(|body| {
        let stream = format!("t{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
        let window = Arc::new(Window {
            credit: Mutex::new(Credit {
                sent: 0,
                acked: 0,
                progress_at: streams.clock.now(),
            }),
            acked: Notify::new(),
            #[cfg(test)]
            probe: Mutex::default(),
        });
        streams.table().insert(
            stream.clone(),
            Handle {
                plugin: id.to_string(),
                window: window.clone(),
                net: net.clone(),
                key: body.running.key(),
            },
        );
        let reader = Reader {
            id: id.to_string(),
            stream: stream.clone(),
            streams: streams.clone(),
            net: net.clone(),
            sink,
            proxy: clients.proxy().clone(),
            window,
            idle: request.idle,
        };
        tokio::spawn(reader.run(body));
        stream
    });
    Ok(StreamOpened {
        status,
        url,
        redirected,
        headers,
        stream,
    })
}

// ---- Reader ----

/// Read and not yet emitted, in one contiguous ring whatever the server's chunking. Its allocation
/// grows to `STREAM_BUFFER` at most, plus the one read that may cross it, and is reused after.
#[derive(Default)]
struct Buffer {
    bytes: VecDeque<u8>,
    /// Bytes taken since the stream began.
    taken: u64,
    /// When the bytes from each position on were read, oldest first; the front one dates the
    /// oldest byte still held.
    marks: VecDeque<(u64, Instant)>,
}

impl Buffer {
    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn capacity(&self) -> usize {
        self.bytes.capacity()
    }

    fn push(&mut self, data: &[u8], now: Instant) {
        let at = self.taken + self.bytes.len() as u64;
        let fresh = self
            .marks
            .back()
            .is_none_or(|(_, last)| now.duration_since(*last) >= MARK_SPACING);
        if fresh && self.marks.len() < MAX_MARKS {
            self.marks.push_back((at, now));
        }
        let needed = self.bytes.len() + data.len();
        if needed > self.bytes.capacity() {
            let grown = (self.bytes.capacity() * 2).clamp(needed, STREAM_BUFFER.max(needed));
            self.bytes.reserve_exact(grown - self.bytes.len());
        }
        self.bytes.extend(data);
    }

    /// The next `n` bytes, `n` at most `len`.
    fn take(&mut self, n: usize) -> Vec<u8> {
        let (front, back) = self.bytes.as_slices();
        let first = n.min(front.len());
        let mut out = Vec::with_capacity(n);
        out.extend_from_slice(&front[..first]);
        out.extend_from_slice(&back[..n - first]);
        self.bytes.drain(..n);
        self.taken += n as u64;
        while self.marks.get(1).is_some_and(|(at, _)| *at <= self.taken) {
            self.marks.pop_front();
        }
        if self.bytes.is_empty() {
            self.marks.clear();
        }
        out
    }

    /// When the oldest byte held is due to be emitted, whether or not a chunk is full.
    fn due_at(&self) -> Option<Instant> {
        self.marks.front().map(|(_, read)| *read + STREAM_COALESCE)
    }
}

/// How a stream ended: none for a complete body, and the transport reason a `proxy` error replaced.
struct End {
    error: Option<ApiError>,
    cause: Option<&'static str>,
}

impl End {
    fn failed(error: ApiError) -> End {
        End {
            error: Some(error),
            cause: None,
        }
    }
}

struct Reader {
    id: String,
    stream: String,
    streams: Streams,
    net: NetState,
    sink: Arc<dyn NetSink>,
    proxy: Proxy,
    window: Arc<Window>,
    idle: Duration,
}

impl Reader {
    async fn run(self, mut body: StreamBody) {
        let pumped = AssertUnwindSafe(self.pump(&mut body)).catch_unwind().await;
        // A panicking reader still ends its stream once, and drops its connection below.
        let end = pumped.unwrap_or_else(|_| End::failed(Refusal::network(CLOSED).into()));
        self.finish(body, end);
    }

    /// Runs the stream until it ends, and says how.
    async fn pump(&self, body: &mut StreamBody) -> End {
        let clock = &self.streams.clock;
        let mut buffer = Buffer::default();
        let mut seq = 0;
        let mut complete = false;
        let mut reading = true;
        let mut last_byte = clock.now();
        loop {
            let pending = self.emit(&mut buffer, &mut seq, complete);
            if complete && buffer.len() == 0 {
                return End {
                    error: None,
                    cause: None,
                };
            }
            let now = clock.now();
            let may_read = !complete && buffer.len() < STREAM_BUFFER;
            // Time spent with a full buffer is the page's delay, not the server's silence.
            if may_read && !reading {
                last_byte = now;
            }
            reading = may_read;
            if self.stalled(now) {
                return End::failed(Refusal::network(STALLED).into());
            }
            if reading && now.duration_since(last_byte) >= self.idle {
                return End::failed(idle_error());
            }
            self.observe(&buffer, true);
            let wake = match pending {
                Some(due) => due.saturating_duration_since(now).min(TICK),
                None => TICK,
            };
            tokio::select! {
                biased;
                error = body.ended.wait() => return End::failed(error),
                () = self.window.acked.notified() => {}
                read = body.response.chunk(), if reading => {
                    match read {
                        Ok(Some(bytes)) => {
                            body.log.received += bytes.len() as u64;
                            last_byte = clock.now();
                            buffer.push(&bytes, last_byte);
                        }
                        Ok(None) => complete = true,
                        Err(error) => return self.failed_read(body, error).await,
                    }
                    self.observe(&buffer, false);
                }
                () = tokio::time::sleep(wake) => {}
            }
        }
    }

    /// Ends the stream at once with a transport failure; what is still buffered is not emitted.
    async fn failed_read(&self, body: &mut StreamBody, error: reqwest::Error) -> End {
        let error = map_transport_error(&error);
        let mut cause = None;
        // Outside the timers: a discovery wait never ends a stream as idle.
        let explained = tokio::select! {
            biased;
            error = body.ended.wait() => return End::failed(error),
            error = explain(&self.proxy, error, &body.url, &mut cause) => error,
        };
        End {
            error: Some(explained),
            cause,
        }
    }

    /// Records what the buffer holds for tests; `checked` counts a timer check.
    #[cfg(test)]
    fn observe(&self, buffer: &Buffer, checked: bool) {
        let mut probe = lock(&self.window.probe);
        probe.checks += u64::from(checked);
        probe.buffered = buffer.len();
        probe.peak_buffered = probe.peak_buffered.max(buffer.len());
        probe.peak_capacity = probe.peak_capacity.max(buffer.capacity());
    }

    #[cfg(not(test))]
    fn observe(&self, _buffer: &Buffer, _checked: bool) {}

    /// Whether data has waited on the page for `STALL_MS` with no acknowledgement.
    fn stalled(&self, now: Instant) -> bool {
        let credit = lock(&self.window.credit);
        credit.sent > credit.acked
            && now.duration_since(credit.progress_at) >= Duration::from_millis(STALL_MS)
    }

    /// Emits what the buffer holds, as far as the window allows.
    /// Returns when the bytes left are due, if the window has room for them but they wait for more.
    fn emit(&self, buffer: &mut Buffer, seq: &mut u64, complete: bool) -> Option<Instant> {
        loop {
            let now = self.streams.clock.now();
            let due = buffer.due_at();
            let ready =
                complete || buffer.len() >= STREAM_CHUNK || due.is_some_and(|due| now >= due);
            let n = {
                let mut credit = lock(&self.window.credit);
                let open = STREAM_WINDOW.saturating_sub(credit.sent - credit.acked);
                let n = buffer.len().min(STREAM_CHUNK).min(open as usize);
                if n == 0 {
                    return None;
                }
                if !ready {
                    return due;
                }
                if credit.sent == credit.acked {
                    credit.progress_at = now;
                }
                credit.sent += n as u64;
                n
            };
            *seq += 1;
            let chunk = StreamEventKind::Chunk {
                seq: *seq,
                data_b64: STANDARD.encode(buffer.take(n)),
            };
            self.sink
                .emit(NetEvent::stream(&self.id, &self.stream, chunk));
        }
    }

    /// Takes the stream out of the table, frees its connection and slot, writes its log entry, then
    /// emits its last event.
    fn finish(self, body: StreamBody, end: End) {
        self.streams.table().remove(&self.stream);
        let last = match &end.error {
            None => StreamEventKind::End,
            Some(error) => StreamEventKind::Error {
                code: error.code,
                reason: error.reason,
            },
        };
        body.finish(&self.net, &self.id, end.error.as_ref(), end.cause);
        self.sink
            .emit(NetEvent::stream(&self.id, &self.stream, last));
    }
}

#[cfg(test)]
mod tests;
