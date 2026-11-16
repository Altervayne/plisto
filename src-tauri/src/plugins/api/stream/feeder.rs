/*
 * The pull feeder: Plisto fetches a stream item's URL and writes the body into the item's byte
 * buffer. Every connection opens through the network lane's streamed head, so the plugin's consented
 * origins, developer mode, the address guard and the per-hop redirect checks apply to each one, read
 * again at every reconnect. The connection is a playback entry of the network state under the item's
 * key: frame events and a crash of the plugin leave it alone, and the item's end closes it at once,
 * whoever ends the item.
 *
 * The first response head decides the item: its content type picks the decoder hint or refuses a
 * playlist or text, and unless the plugin said, a body with no length or with ICY headers is live. A
 * finite body of at most `FINITE_MAX` is kept whole and seekable; anything else plays from a ring,
 * and a full ring stops the reads, so TCP slows the server. Every later head must match the first.
 *
 * A live item reconnects after a drop, an idle connection or a 5xx, at most
 * `RECONNECT_BACKOFF_MS.len()` times in a row. A live item paused past `LIVE_PAUSE_HOLD_MS`
 * closes its connection and starts a fresh epoch, so nothing buffered before the hold is heard;
 * it reconnects on resume. A finite item resumes once with a validated range request. Nothing is
 * retried after a refusal, a TLS failure or a 4xx. The feeder runs on the async runtime and never
 * holds the hub lock across a wait; its timers read the hub's clock and are checked at least every
 * `TICK`, and each step that acts on the item first checks it is still the one seated.
 */

// -- Library Imports --
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use tauri::Url;

// -- Local Imports --
use self::head::{failure, logged, Shape};
use super::args::Pull;
use super::hub::{Shared, StreamHub};
use super::NowState;
use crate::audio::stream::{
    GrowingWriter, IcyStripper, RingWriter, StreamControl, WriteError, IDLE_MS, LIVE_PAUSE_HOLD_MS,
    RECONNECT_BACKOFF_MS, RECONNECT_RESET_MS,
};
use crate::audio::StreamEndReason;
use crate::plugins::api::error::{ApiCode, ApiError};
use crate::plugins::api::net::client::Clients;
use crate::plugins::api::net::fetch::{
    error_text, explain, map_transport_error, open_streamed_with, unix_ms, StreamBody, StreamHead,
};
use crate::plugins::api::net::policy::Consent;
use crate::plugins::api::net::proxy::Clock;
use crate::plugins::api::net::state::{LogKind, NetLogEntry, NetState, StreamKind};
use crate::plugins::api::net::{CLOSED, CONNECT};
use crate::plugins::state::Serving;

// -- Module Declarations --
mod head;
mod session;

/// The `network` detail of a response whose status ends the item.
pub const STATUS: &str = "status";
/// The longest any wait sleeps before it checks the item and its timers again.
const TICK: Duration = Duration::from_millis(50);
/// How many times an open refused `busy` is tried again, `TICK` apart, while the slot of an item
/// that just ended is being freed.
const BUSY_TRIES: usize = 10;

/// What a plugin's requests go out with.
pub struct Wire {
    pub clients: &'static Clients,
    pub net: NetState,
    pub user_agent: String,
}

/// Where the body goes.
enum Bytes {
    Ring(RingWriter),
    Body(GrowingWriter),
}

/// What the feeder knows across the item's connections.
struct Progress {
    /// None until a head of the current epoch.
    bytes: Option<Bytes>,
    /// What the first head said; every later head must say the same.
    shape: Option<Shape>,
    live: bool,
    /// The finite body's length.
    length: Option<u64>,
    /// Body bytes taken from the network, ICY blocks included: the offset a resume continues from.
    received: u64,
    /// The first response's strong ETag, else its Last-Modified, for `if-range`.
    validator: Option<String>,
    ranges: bool,
    resumed: bool,
    attempts: usize,
    playing_since: Option<Instant>,
}

/// What follows a connection.
enum Next {
    /// The body is complete, or the item is gone.
    Done,
    /// A failure a live item reconnects after.
    Retry(StreamEndReason, Option<&'static str>),
    /// A finite body stopped short.
    Resume,
    /// A paused live item's connection was closed; a fresh epoch starts once it plays again.
    Hold,
    /// The plugin was out of the serving set: tried again like a failed connect, live or not.
    Absent,
    End(StreamEndReason, Option<&'static str>),
}

/// The log outcome of a connection Plisto closed itself.
fn stopped() -> ApiError {
    ApiError::aborted("stopped")
}

/// Starts fetching pull item `id` of plugin `plugin` on the async runtime.
pub(super) fn spawn_feeder(
    hub: &StreamHub,
    id: i64,
    plugin: &str,
    pull: Pull,
    wire: Arc<Wire>,
    control: &Arc<StreamControl>,
) {
    let feeder = Feeder {
        hub: Arc::downgrade(&hub.0),
        id,
        plugin: plugin.to_string(),
        pull,
        wire,
        control: Arc::clone(control),
        clock: hub.clock(),
    };
    tauri::async_runtime::spawn(feeder.run());
}

struct Feeder {
    hub: Weak<Shared>,
    id: i64,
    plugin: String,
    pull: Pull,
    wire: Arc<Wire>,
    /// The current epoch's control.
    control: Arc<StreamControl>,
    clock: Arc<dyn Clock>,
}

impl Feeder {
    fn hub(&self) -> Option<StreamHub> {
        self.hub.upgrade().map(StreamHub)
    }

    /// The item's engine state while it is still the one seated.
    fn view(&self) -> Option<NowState> {
        if self.control.is_cancelled() {
            return None;
        }
        self.hub()?.pull_state(self.id)
    }

    /// Resolves once the item is no longer seated.
    async fn gone(&self) {
        while self.view().is_some() {
            tokio::time::sleep(TICK).await;
        }
    }

    /// Waits `wait` on the hub's clock. False when the item went meanwhile.
    async fn sleep(&self, wait: Duration) -> bool {
        let until = self.clock.now() + wait;
        while self.view().is_some() {
            if self.clock.now() >= until {
                return true;
            }
            tokio::time::sleep(TICK).await;
        }
        false
    }

    /// Waits until the item is no longer paused. False when it went meanwhile.
    async fn until_resumed(&self) -> bool {
        loop {
            match self.view() {
                None => return false,
                Some(NowState::Paused) => tokio::time::sleep(TICK).await,
                Some(_) => return true,
            }
        }
    }

    async fn run(mut self) {
        let mut state = Progress {
            bytes: None,
            shape: None,
            live: self.pull.live.unwrap_or(true),
            length: None,
            received: 0,
            validator: None,
            ranges: false,
            resumed: false,
            attempts: 0,
            playing_since: None,
        };
        let (reason, detail) = loop {
            match self.connect(&mut state).await {
                Next::Done => return,
                Next::End(reason, detail) => break (reason, detail),
                next @ (Next::Retry(..) | Next::Absent) => {
                    let (reason, detail, retried) = match next {
                        Next::Retry(reason, detail) => (reason, detail, state.live),
                        _ => (StreamEndReason::Network, Some(CONNECT), true),
                    };
                    let Some(wait) = RECONNECT_BACKOFF_MS.get(state.attempts).filter(|_| retried)
                    else {
                        break (reason, detail);
                    };
                    state.attempts += 1;
                    self.reconnecting(true);
                    if !self.sleep(Duration::from_millis(*wait)).await {
                        return;
                    }
                }
                Next::Resume if state.ranges && !state.resumed => state.resumed = true,
                Next::Resume => break (StreamEndReason::Network, Some(CLOSED)),
                Next::Hold => {
                    let epoch = self.hub().and_then(|hub| hub.pull_epoch(self.id));
                    let Some(control) = epoch else {
                        return;
                    };
                    // The old ring's writer goes with its epoch, already cancelled.
                    state.bytes = None;
                    state.received = 0;
                    self.control = control;
                    if !self.until_resumed().await {
                        return;
                    }
                }
            }
        };
        // An item whose plugin is still out of the serving set waits for it to come back or for
        // `forget`, so this end never beats `plugin_gone`.
        while self.view().is_some() && !self.hub().is_some_and(|hub| hub.serves(&self.plugin)) {
            tokio::time::sleep(TICK).await;
        }
        // Ended before the byte buffer drops, so the decoder's broken source ends nothing more.
        if let Some(hub) = self.hub() {
            hub.pull_end(self.id, reason, detail);
        }
        drop(state);
    }

    fn reconnecting(&self, on: bool) {
        if let Some(hub) = self.hub() {
            hub.pull_reconnecting(self.id, on, self.clock.now());
        }
    }

    /// Writes the log entry of a connection dropped before its head arrived.
    fn log_dropped(&self, started: Instant, at_ms: u64) {
        let Ok(url) = Url::parse(&self.pull.url) else {
            return;
        };
        let mut entry = NetLogEntry::new(LogKind::Playback, "GET", &url, at_ms);
        entry.error = Some(error_text(&stopped(), None));
        entry.ms = started.elapsed().as_millis() as u64;
        self.wire.net.record(&self.plugin, entry);
    }

    /// Opens the next connection. A `busy` refusal is tried again for a moment, while the slot of
    /// the item this one replaced is freed. None when the item went meanwhile.
    async fn open(
        &self,
        state: &Progress,
        serving: &Serving,
    ) -> Option<Result<StreamHead, ApiError>> {
        let (request, own) = self.request(state);
        for _ in 0..BUSY_TRIES {
            let consent = Consent {
                origins: &serving.origins,
                dev_mode: serving.dev_mode,
            };
            let (net, kind) = (&self.wire.net, StreamKind::Playback);
            let (started, at_ms) = (Instant::now(), unix_ms());
            let opening = open_streamed_with(
                self.wire.clients,
                net,
                &self.plugin,
                consent,
                &request,
                kind,
                &own,
            );
            let opened = tokio::select! {
                biased;
                opened = opening => opened,
                () = self.gone() => {
                    self.log_dropped(started, at_ms);
                    return None;
                }
            };
            match opened {
                Err(error) if error.code == ApiCode::Busy => {
                    tokio::time::sleep(TICK).await;
                    self.view()?;
                }
                opened => return Some(opened),
            }
        }
        Some(Err(ApiError::busy()))
    }

    /// One connection, from its request to the end of its body.
    async fn connect(&self, state: &mut Progress) -> Next {
        // Out of the serving set: for good after a disable, whose `forget` ends the item, or for a
        // moment while the plugin's state changes.
        let Some(serving) = self.hub().and_then(|hub| hub.serving_of(&self.plugin)) else {
            return if self.view().is_some() {
                Next::Absent
            } else {
                Next::Done
            };
        };
        let Some(opened) = self.open(state, &serving).await else {
            return Next::Done;
        };
        let net = &self.wire.net;
        let head = match opened {
            Ok(head) => head,
            Err(_) if self.view().is_none() => return Next::Done,
            Err(error) => return failure(&error),
        };
        let (icy, shape) = match self.check_head(&head, state) {
            Ok(checked) => checked,
            Err(next) => {
                if let Some(body) = head.body {
                    body.finish(net, &self.plugin, Some(&logged(&next)), None);
                }
                return next;
            }
        };
        let Some(mut body) = head.body else {
            return Next::End(StreamEndReason::Network, Some(STATUS));
        };
        if state.bytes.is_none() {
            if let Err(next) = self.first_head(&head.headers, state, shape) {
                body.finish(net, &self.plugin, Some(&logged(&next)), None);
                return next;
            }
        }
        self.reconnecting(false);
        let (next, error, cause) = self.pump(&mut body, state, icy).await;
        body.finish(net, &self.plugin, error.as_ref(), cause);
        next
    }

    /// Moves what `pending` holds into the byte buffer, as far as it has room. False when the buffer
    /// is closed: the item is ending.
    fn write(&self, state: &Progress, pending: &mut Vec<u8>) -> bool {
        if pending.is_empty() {
            return true;
        }
        match &state.bytes {
            Some(Bytes::Ring(writer)) => {
                let n = writer.room().min(pending.len());
                if n == 0 {
                    return true;
                }
                match writer.try_write(&pending[..n]) {
                    Ok(_) => {
                        pending.drain(..n);
                        true
                    }
                    Err(WriteError::Full { .. }) => true,
                    Err(_) => false,
                }
            }
            Some(Bytes::Body(writer)) => {
                let written = match writer.write(pending) {
                    // A body longer than it said: what fits is the body.
                    Err(WriteError::Full { room }) => writer.write(&pending[..room]),
                    other => other,
                };
                pending.clear();
                written.is_ok()
            }
            None => false,
        }
    }

    /// The body is over: a live item reconnects, a finite one is complete or resumes.
    fn body_ended(&self, state: &mut Progress) -> Next {
        if state.live {
            return Next::Retry(StreamEndReason::Network, Some(CLOSED));
        }
        if state.length.is_some_and(|len| state.received < len) {
            return Next::Resume;
        }
        match state.bytes.take() {
            Some(Bytes::Body(writer)) => writer.finish(),
            Some(Bytes::Ring(writer)) => writer.finish(),
            None => {}
        }
        Next::Done
    }

    /// Reads the body into the byte buffer until it ends, fails, idles, or the item pauses past its
    /// hold or goes. Returns what follows, with the error and its replaced cause for the log entry.
    async fn pump(
        &self,
        body: &mut StreamBody,
        state: &mut Progress,
        mut icy: Option<IcyStripper>,
    ) -> (Next, Option<ApiError>, Option<&'static str>) {
        let mut pending = Vec::new();
        let mut last_byte = self.clock.now();
        let mut paused_since = None;
        let mut reading = true;
        loop {
            if !self.write(state, &mut pending) {
                return (Next::Done, Some(stopped()), None);
            }
            let Some(view) = self.view() else {
                return (Next::Done, Some(stopped()), None);
            };
            let now = self.clock.now();
            if view == NowState::Playing {
                let since = *state.playing_since.get_or_insert(now);
                if now.saturating_duration_since(since) >= Duration::from_millis(RECONNECT_RESET_MS)
                {
                    state.attempts = 0;
                }
            } else {
                state.playing_since = None;
            }
            if state.live && view == NowState::Paused {
                let since = *paused_since.get_or_insert(now);
                if now.saturating_duration_since(since) >= Duration::from_millis(LIVE_PAUSE_HOLD_MS)
                {
                    return (Next::Hold, Some(stopped()), None);
                }
            } else {
                paused_since = None;
            }
            let may_read = pending.is_empty();
            // Time spent with a full buffer is the player's delay, not the server's silence.
            if may_read && !reading {
                last_byte = now;
            }
            reading = may_read;
            if reading && now.saturating_duration_since(last_byte) >= Duration::from_millis(IDLE_MS)
            {
                let next = if state.live {
                    Next::Retry(StreamEndReason::Network, Some(CLOSED))
                } else {
                    Next::End(StreamEndReason::Network, Some(CLOSED))
                };
                return (next, Some(ApiError::network(CLOSED)), None);
            }
            tokio::select! {
                biased;
                error = body.ended.wait() => return (Next::Done, Some(error), None),
                read = body.response.chunk(), if reading => match read {
                    Ok(Some(chunk)) => {
                        body.log.received += chunk.len() as u64;
                        state.received += chunk.len() as u64;
                        last_byte = self.clock.now();
                        match &mut icy {
                            Some(stripper) => {
                                if let Some(title) = stripper.feed(&chunk, &mut pending) {
                                    if let Some(hub) = self.hub() {
                                        hub.icy_title(self.id, &title);
                                    }
                                }
                            }
                            None => pending.extend_from_slice(&chunk),
                        }
                    }
                    Ok(None) => {
                        if !self.write(state, &mut pending) {
                            return (Next::Done, Some(stopped()), None);
                        }
                        return (self.body_ended(state), None, None);
                    }
                    Err(error) => {
                        let mut cause = None;
                        let error = map_transport_error(&error);
                        let proxy = self.wire.clients.proxy();
                        let error = explain(proxy, error, &body.url, &mut cause).await;
                        let next = match failure(&error) {
                            Next::Retry(..) if !state.live => Next::Resume,
                            next => next,
                        };
                        return (next, Some(error), cause);
                    }
                },
                () = tokio::time::sleep(TICK) => {}
            }
        }
    }
}
