/*
 * What the network methods have running, and what they sent. Each fetch, stream and socket is an entry
 * holding a cap slot and a cancel callback; the `Running` guard that owns it frees the slot when
 * dropped, on every path including a panic unwind. A cancel callback fires exactly once, with the
 * reason that ended its entry, and always outside the lock, so it may touch this state itself. A
 * stream or socket holds no in-flight slot: only the call that opens it does, until it resolves.
 * A stream that plays through Plisto's engine is a `Playback` entry, opened behind a `PlaybackHead`
 * until its headers: they share the stream and fetch caps, but neither a page's abort, a frame event
 * nor the `forget` sweep ends them. They end only through `end` or their own guard.
 * A call takes the plugin's ticket when admitted; work it registers after a forget or frame event that
 * would have ended it is refused, so nothing outlives those events by racing them.
 * A plugin's log outlives its entries and is kept until the app quits, 200 lines at most per plugin.
 */

// -- Library Imports --
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Url;

// -- Local Imports --
use crate::plugins::api::error::ApiError;
use crate::plugins::api::state::lock;

// ---- Caps ----

/// Fetches until their headers, or their body when buffered.
pub const MAX_FETCHES_PER_PLUGIN: usize = 4;
pub const MAX_FETCHES: usize = 12;
pub const MAX_STREAMS_PER_PLUGIN: usize = 2;
pub const MAX_STREAMS: usize = 8;
pub const MAX_SOCKETS_PER_PLUGIN: usize = 2;
pub const MAX_SOCKETS: usize = 8;
/// Log entries kept per plugin; the oldest goes first.
pub const LOG_CAPACITY: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Fetch,
    /// A stream read by the plugin's page.
    Stream,
    /// A stream played through Plisto's engine.
    Playback,
    /// The request of a playback stream, until its headers.
    PlaybackHead,
    Socket,
}

impl Kind {
    /// The kind whose cap this one counts against.
    fn group(self) -> Kind {
        match self {
            Kind::Playback => Kind::Stream,
            Kind::PlaybackHead => Kind::Fetch,
            kind => kind,
        }
    }

    /// Per plugin, then app-wide.
    fn caps(self) -> (usize, usize) {
        match self.group() {
            Kind::Fetch => (MAX_FETCHES_PER_PLUGIN, MAX_FETCHES),
            Kind::Socket => (MAX_SOCKETS_PER_PLUGIN, MAX_SOCKETS),
            _ => (MAX_STREAMS_PER_PLUGIN, MAX_STREAMS),
        }
    }

    /// Ended by a page's abort, a frame event and `forget`; playback work is not.
    fn ends_with_page(self) -> bool {
        !matches!(self, Kind::Playback | Kind::PlaybackHead)
    }
}

/// Who reads a streamed body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Page,
    Playback,
}

impl StreamKind {
    pub fn kind(self) -> Kind {
        match self {
            StreamKind::Page => Kind::Stream,
            StreamKind::Playback => Kind::Playback,
        }
    }

    /// The kind of the slot held until the headers.
    pub fn head_kind(self) -> Kind {
        match self {
            StreamKind::Page => Kind::Fetch,
            StreamKind::Playback => Kind::PlaybackHead,
        }
    }

    pub fn log_kind(self) -> LogKind {
        match self {
            StreamKind::Page => LogKind::Stream,
            StreamKind::Playback => LogKind::Playback,
        }
    }
}

/// Why an entry ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    /// `net.abort` or `net.stream.cancel`.
    Abort,
    /// The plugin's frame detached or crashed.
    FrameGone,
    /// The plugin was disabled, updated or uninstalled.
    Stopped,
    /// Its guard was dropped: the work is over, or its owner unwound.
    Finished,
}

impl EndReason {
    /// The `aborted` reason a cancelled call resolves with; none for `Finished`.
    pub fn reason(self) -> Option<&'static str> {
        match self {
            EndReason::Abort => Some("abort"),
            EndReason::FrameGone => Some("frame_gone"),
            EndReason::Stopped => Some("stopped"),
            EndReason::Finished => None,
        }
    }

    pub fn error(self) -> Option<ApiError> {
        self.reason().map(ApiError::aborted)
    }
}

/// Stops the work behind an entry. It runs on the thread that ended the entry, so it must not block
/// or panic, and it must close the connection at once: the entry's cap slot is already free.
pub type CancelFn = Box<dyn FnOnce(EndReason) + Send>;

struct Entry {
    plugin: String,
    kind: Kind,
    abort_key: Option<String>,
    cancel: CancelFn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LogKind {
    Fetch,
    Stream,
    Playback,
    Socket,
}

/// One request Plisto sent for a plugin. Holds the origin only: never a path, query, header or body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetLogEntry {
    pub at_ms: u64,
    pub kind: LogKind,
    pub method: String,
    origin: String,
    pub status: Option<u16>,
    /// `code` or `code/reason`.
    pub error: Option<String>,
    pub sent: u64,
    pub received: u64,
    pub ms: u64,
}

impl NetLogEntry {
    /// An entry for a request to `url`, of which only the origin is kept.
    pub fn new(kind: LogKind, method: &str, url: &Url, at_ms: u64) -> NetLogEntry {
        NetLogEntry {
            at_ms,
            kind,
            method: method.to_string(),
            origin: url.origin().ascii_serialization(),
            status: None,
            error: None,
            sent: 0,
            received: 0,
            ms: 0,
        }
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }
}

/// How many times a plugin was forgotten and lost its frame, as a call admitted at that moment saw
/// it. Work registered under an older ticket is refused: it was admitted before an event that would
/// have ended it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Ticket {
    stopped: u64,
    frames: u64,
}

#[derive(Default)]
struct Inner {
    next_key: u64,
    running: HashMap<u64, Entry>,
    logs: HashMap<String, VecDeque<NetLogEntry>>,
    // Never shrinks: one entry per plugin that was ever forgotten or lost a frame.
    tickets: HashMap<String, Ticket>,
}

impl Inner {
    fn count(&self, kind: Kind, plugin: Option<&str>) -> usize {
        self.running
            .values()
            .filter(|e| e.kind.group() == kind.group() && plugin.is_none_or(|id| e.plugin == id))
            .count()
    }

    /// Takes out every entry `pick` selects, so their callbacks can fire after the lock is released.
    fn take(&mut self, pick: impl Fn(&Entry) -> bool) -> Vec<CancelFn> {
        let keys: Vec<u64> = self
            .running
            .iter()
            .filter(|(_, e)| pick(e))
            .map(|(key, _)| *key)
            .collect();
        keys.into_iter()
            .filter_map(|key| self.running.remove(&key))
            .map(|e| e.cancel)
            .collect()
    }
}

fn fire(callbacks: Vec<CancelFn>, why: EndReason) -> usize {
    let count = callbacks.len();
    for cancel in callbacks {
        cancel(why);
    }
    count
}

/// Cheap to clone; every clone shares the same state. A clone from `bound` also carries the ticket its
/// registrations are checked against.
#[derive(Clone, Default)]
pub struct NetState(Arc<Mutex<Inner>>, Option<Ticket>);

/// Holds one running entry and its cap slot; dropping it ends the entry with `Finished` unless
/// something ended it first.
pub struct Running {
    state: NetState,
    key: u64,
}

impl Running {
    /// Names the entry for `NetState::end`.
    pub fn key(&self) -> u64 {
        self.key
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let entry = lock(&self.state.0).running.remove(&self.key);
        if let Some(entry) = entry {
            (entry.cancel)(EndReason::Finished);
        }
    }
}

impl NetState {
    /// Plugin `id`'s ticket now, taken when a call is admitted.
    pub fn ticket(&self, id: &str) -> Ticket {
        lock(&self.0).tickets.get(id).copied().unwrap_or_default()
    }

    /// This state, refusing registrations made after `ticket` went stale.
    pub fn bound(&self, ticket: Ticket) -> NetState {
        NetState(self.0.clone(), Some(ticket))
    }

    /// Registers a running fetch, stream or socket of plugin `id`, refused `busy` when the plugin or
    /// the app already holds its kind's cap. Bound to a ticket, it is refused `unavailable` once the
    /// plugin was forgotten since, and `aborted` / `frame_gone` once its frame went, except playback
    /// work, which a frame event does not end.
    pub fn open(
        &self,
        id: &str,
        kind: Kind,
        abort_key: Option<&str>,
        cancel: CancelFn,
    ) -> Result<Running, ApiError> {
        let mut inner = lock(&self.0);
        if let Some(admitted) = self.1 {
            let now = inner.tickets.get(id).copied().unwrap_or_default();
            if now.stopped != admitted.stopped {
                return Err(ApiError::unavailable());
            }
            if now.frames != admitted.frames && kind.ends_with_page() {
                return Err(ApiError::aborted("frame_gone"));
            }
        }
        let (per_plugin, app_wide) = kind.caps();
        if inner.count(kind, Some(id)) >= per_plugin || inner.count(kind, None) >= app_wide {
            return Err(ApiError::busy());
        }
        let key = inner.next_key;
        inner.next_key += 1;
        inner.running.insert(
            key,
            Entry {
                plugin: id.to_string(),
                kind,
                abort_key: abort_key.map(str::to_string),
                cancel,
            },
        );
        Ok(Running {
            state: self.clone(),
            key,
        })
    }

    /// Ends `id`'s entries opened with `abort_key`, except playback work. Returns how many ended.
    pub fn abort(&self, id: &str, abort_key: &str) -> usize {
        let callbacks = lock(&self.0).take(|e| {
            e.plugin == id && e.kind.ends_with_page() && e.abort_key.as_deref() == Some(abort_key)
        });
        fire(callbacks, EndReason::Abort)
    }

    /// Ends `id`'s entries opened with `abort_key`, playback work included, with `stopped`: Plisto's
    /// own end of work it started for the plugin. Returns how many ended.
    pub fn end_keyed(&self, id: &str, abort_key: &str) -> usize {
        let callbacks = lock(&self.0)
            .take(|e| e.plugin == id && e.abort_key.as_deref() == Some(abort_key));
        fire(callbacks, EndReason::Stopped)
    }

    /// Ends the entry `key` with `why`. False when it already ended.
    pub fn end(&self, key: u64, why: EndReason) -> bool {
        let entry = lock(&self.0).running.remove(&key);
        match entry {
            Some(entry) => {
                (entry.cancel)(why);
                true
            }
            None => false,
        }
    }

    /// Ends what `id` has running because its frame detached or crashed, except playback work.
    pub fn frame_gone(&self, id: &str) {
        let callbacks = {
            let mut inner = lock(&self.0);
            inner.tickets.entry(id.to_string()).or_default().frames += 1;
            inner.take(|e| e.plugin == id && e.kind.ends_with_page())
        };
        fire(callbacks, EndReason::FrameGone);
    }

    /// Ends what `id` has running because it stopped serving, except playback work, which its owner
    /// ends. Its log is kept.
    pub fn forget(&self, id: &str) {
        let callbacks = {
            let mut inner = lock(&self.0);
            inner.tickets.entry(id.to_string()).or_default().stopped += 1;
            inner.take(|e| e.plugin == id && e.kind.ends_with_page())
        };
        fire(callbacks, EndReason::Stopped);
    }

    /// The page streams `id` holds, then those of every plugin; playback streams are not counted.
    pub fn page_streams(&self, id: &str) -> (usize, usize) {
        let inner = lock(&self.0);
        let pages = inner.running.values().filter(|e| e.kind == Kind::Stream);
        let (mut mine, mut all) = (0, 0);
        for entry in pages {
            all += 1;
            mine += usize::from(entry.plugin == id);
        }
        (mine, all)
    }

    /// Appends to `id`'s log, dropping its oldest entry past `LOG_CAPACITY`.
    pub fn record(&self, id: &str, entry: NetLogEntry) {
        let mut inner = lock(&self.0);
        let log = inner.logs.entry(id.to_string()).or_default();
        if log.len() == LOG_CAPACITY {
            log.pop_front();
        }
        log.push_back(entry);
    }

    /// `id`'s log, oldest first.
    pub fn log(&self, id: &str) -> Vec<NetLogEntry> {
        lock(&self.0)
            .logs
            .get(id)
            .map(|log| log.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Counts playback work with the kind whose cap it shares.
    #[cfg(test)]
    pub fn running(&self, id: &str, kind: Kind) -> usize {
        lock(&self.0).count(kind, Some(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::state::ApiState;

    const A: &str = "com.example.a";
    const B: &str = "com.example.b";

    /// A callback that records each reason it fires with.
    fn recorder() -> (CancelFn, Arc<Mutex<Vec<EndReason>>>) {
        let fired = Arc::new(Mutex::new(Vec::new()));
        let sink = fired.clone();
        let cancel: CancelFn = Box::new(move |why| sink.lock().unwrap().push(why));
        (cancel, fired)
    }

    fn noop() -> CancelFn {
        Box::new(|_| {})
    }

    #[test]
    fn each_cap_refuses_busy_one_past_its_limit_and_frees_on_drop() {
        for kind in [Kind::Fetch, Kind::Stream, Kind::Socket] {
            let (per_plugin, app_wide) = kind.caps();
            let net = NetState::default();
            let mut held: Vec<Running> = (0..per_plugin)
                .map(|_| net.open(A, kind, None, noop()).unwrap())
                .collect();
            let busy = net.open(A, kind, None, noop()).err().unwrap();
            assert_eq!(busy.code, ApiCode::Busy, "{kind:?}");
            held.pop();
            held.push(net.open(A, kind, None, noop()).unwrap());

            // Fill the app-wide cap from other plugins.
            let mut n = 0;
            while held.len() < app_wide {
                held.push(
                    net.open(&format!("com.example.p{n}"), kind, None, noop())
                        .unwrap(),
                );
                n += 1;
            }
            let busy = net.open("com.example.late", kind, None, noop()).err();
            assert_eq!(busy.map(|e| e.code), Some(ApiCode::Busy), "{kind:?}");
            held.pop();
            assert!(net.open("com.example.late", kind, None, noop()).is_ok());
        }
    }

    #[test]
    fn the_kinds_count_apart() {
        let net = NetState::default();
        let _fetches: Vec<Running> = (0..MAX_FETCHES_PER_PLUGIN)
            .map(|_| net.open(A, Kind::Fetch, None, noop()).unwrap())
            .collect();
        assert!(net.open(A, Kind::Stream, None, noop()).is_ok());
        assert!(net.open(A, Kind::Socket, None, noop()).is_ok());
    }

    #[test]
    fn a_stream_holds_no_in_flight_slot() {
        let api = ApiState::default();
        let _streams: Vec<Running> = (0..MAX_STREAMS_PER_PLUGIN)
            .map(|_| api.net().open(A, Kind::Stream, None, noop()).unwrap())
            .collect();
        let _sockets: Vec<Running> = (0..MAX_SOCKETS_PER_PLUGIN)
            .map(|_| api.net().open(A, Kind::Socket, None, noop()).unwrap())
            .collect();
        assert_eq!(api.in_flight(A), 0);
        let calls: Vec<_> = (0..crate::plugins::api::MAX_IN_FLIGHT)
            .map(|_| api.enter(A).unwrap())
            .collect();
        assert_eq!(calls.len(), 16);
    }

    #[test]
    fn a_dropped_guard_fires_its_callback_once_and_a_later_end_does_not() {
        let net = NetState::default();
        let (cancel, fired) = recorder();
        let running = net.open(A, Kind::Fetch, Some("k"), cancel).unwrap();
        drop(running);
        net.abort(A, "k");
        net.frame_gone(A);
        net.forget(A);
        assert_eq!(*fired.lock().unwrap(), [EndReason::Finished]);
        assert_eq!(net.running(A, Kind::Fetch), 0);
    }

    #[test]
    fn an_unwinding_owner_frees_the_slot_and_fires_once() {
        let net = NetState::default();
        let (cancel, fired) = recorder();
        let owner = net.clone();
        let result = std::thread::spawn(move || {
            let _running = owner.open(A, Kind::Fetch, None, cancel).unwrap();
            panic!("the owner fails mid-request");
        })
        .join();
        assert!(result.is_err());
        assert_eq!(*fired.lock().unwrap(), [EndReason::Finished]);
        assert_eq!(net.running(A, Kind::Fetch), 0);
    }

    #[test]
    fn abort_by_key_ends_only_that_key_of_that_plugin() {
        let net = NetState::default();
        let (k1, fired_k1) = recorder();
        let (k1_again, fired_k1_again) = recorder();
        let (k2, fired_k2) = recorder();
        let (none, fired_none) = recorder();
        let (other, fired_other) = recorder();
        let held = [
            net.open(A, Kind::Fetch, Some("k1"), k1).unwrap(),
            net.open(A, Kind::Stream, Some("k1"), k1_again).unwrap(),
            net.open(A, Kind::Fetch, Some("k2"), k2).unwrap(),
            net.open(A, Kind::Fetch, None, none).unwrap(),
            net.open(B, Kind::Fetch, Some("k1"), other).unwrap(),
        ];

        assert_eq!(net.abort(A, "k1"), 2);
        assert_eq!(net.abort(A, "k1"), 0);
        assert_eq!(net.abort(A, "missing"), 0);
        assert_eq!(*fired_k1.lock().unwrap(), [EndReason::Abort]);
        assert_eq!(*fired_k1_again.lock().unwrap(), [EndReason::Abort]);
        assert!(fired_k2.lock().unwrap().is_empty());
        assert!(fired_none.lock().unwrap().is_empty());
        assert!(fired_other.lock().unwrap().is_empty());
        assert_eq!(net.running(A, Kind::Fetch), 2);
        assert_eq!(net.running(A, Kind::Stream), 0);

        // The aborted guards drop without firing again.
        drop(held);
        assert_eq!(*fired_k1.lock().unwrap(), [EndReason::Abort]);
        assert_eq!(*fired_k2.lock().unwrap(), [EndReason::Finished]);
    }

    /// Opens one entry of each kind for `A` and one for `B`, then ends them with `end`.
    fn end_all_of_a(end: impl Fn(&NetState), expected: EndReason) {
        let net = NetState::default();
        let mut fired_a = Vec::new();
        let mut held = Vec::new();
        for kind in [Kind::Fetch, Kind::Stream, Kind::Socket] {
            let (cancel, fired) = recorder();
            held.push(net.open(A, kind, Some("k"), cancel).unwrap());
            fired_a.push(fired);
        }
        let (cancel, fired_b) = recorder();
        held.push(net.open(B, Kind::Stream, None, cancel).unwrap());

        end(&net);
        end(&net);
        for fired in &fired_a {
            assert_eq!(*fired.lock().unwrap(), [expected]);
        }
        assert!(fired_b.lock().unwrap().is_empty());
        for kind in [Kind::Fetch, Kind::Stream, Kind::Socket] {
            assert_eq!(net.running(A, kind), 0);
        }
        assert_eq!(net.running(B, Kind::Stream), 1);

        drop(held);
        for fired in &fired_a {
            assert_eq!(*fired.lock().unwrap(), [expected]);
        }
        assert_eq!(*fired_b.lock().unwrap(), [EndReason::Finished]);
    }

    #[test]
    fn a_frame_event_ends_every_entry_of_its_plugin_once() {
        end_all_of_a(|net| net.frame_gone(A), EndReason::FrameGone);
    }

    #[test]
    fn forget_ends_every_entry_of_its_plugin_once() {
        end_all_of_a(|net| net.forget(A), EndReason::Stopped);
    }

    #[test]
    fn a_playback_stream_shares_the_stream_caps() {
        let net = NetState::default();
        let _page = net.open(A, Kind::Stream, None, noop()).unwrap();
        let _playback = net.open(A, Kind::Playback, None, noop()).unwrap();
        let third = net.open(A, Kind::Playback, None, noop()).err();
        assert_eq!(third.map(|e| e.code), Some(ApiCode::Busy));
        assert!(net.open(A, Kind::Stream, None, noop()).is_err());
        assert_eq!(net.running(A, Kind::Stream), 2);
    }

    #[test]
    fn a_page_abort_skips_playback_work_with_the_same_key() {
        let net = NetState::default();
        let (cancel, playback) = recorder();
        let _playback = net.open(A, Kind::Playback, Some("k"), cancel).unwrap();
        let (cancel, head) = recorder();
        let _head = net.open(A, Kind::PlaybackHead, Some("k"), cancel).unwrap();
        let (cancel, page) = recorder();
        let _page = net.open(A, Kind::Stream, Some("k"), cancel).unwrap();
        assert_eq!(net.abort(A, "k"), 1);
        assert_eq!(*page.lock().unwrap(), [EndReason::Abort]);
        assert!(playback.lock().unwrap().is_empty());
        assert!(head.lock().unwrap().is_empty());
        assert_eq!(net.running(A, Kind::Fetch), 1);
        assert_eq!(net.running(A, Kind::Stream), 1);
    }

    #[test]
    fn a_playback_stream_outlives_frame_events_and_forget_and_ends_by_key() {
        let net = NetState::default();
        let (cancel, fired) = recorder();
        let playback = net.open(A, Kind::Playback, Some("k"), cancel).unwrap();
        let (cancel, page) = recorder();
        let _page = net.open(A, Kind::Stream, None, cancel).unwrap();
        net.frame_gone(A);
        net.forget(A);
        assert_eq!(*page.lock().unwrap(), [EndReason::FrameGone]);
        assert!(fired.lock().unwrap().is_empty());
        assert_eq!(net.running(A, Kind::Playback), 1);

        assert!(net.end(playback.key(), EndReason::Stopped));
        assert!(!net.end(playback.key(), EndReason::Abort));
        assert_eq!(net.running(A, Kind::Playback), 0);
        drop(playback);
        assert_eq!(*fired.lock().unwrap(), [EndReason::Stopped]);
    }

    #[test]
    fn a_stale_ticket_refuses_registration_with_the_event_that_staled_it() {
        let net = NetState::default();
        let page = [Kind::Fetch, Kind::Stream, Kind::Socket];
        let playback = [Kind::Playback, Kind::PlaybackHead];

        // A frame event refuses page work and leaves playback work alone.
        let before = net.bound(net.ticket(A));
        net.frame_gone(A);
        for kind in page {
            let refused = before.open(A, kind, None, noop()).err().unwrap();
            assert_eq!(refused, ApiError::aborted("frame_gone"), "{kind:?}");
        }
        let held: Vec<Running> = playback
            .iter()
            .map(|kind| before.open(A, *kind, None, noop()).unwrap())
            .collect();
        drop(held);

        // A forget refuses everything.
        let before = net.bound(net.ticket(A));
        net.forget(A);
        for kind in page.into_iter().chain(playback) {
            let refused = before.open(A, kind, None, noop()).err().unwrap();
            assert_eq!(refused, ApiError::unavailable(), "{kind:?}");
        }
        for kind in page.into_iter().chain(playback) {
            assert_eq!(net.running(A, kind), 0);
        }

        // A fresh ticket, another plugin's events and an unbound state register as before.
        let now = net.bound(net.ticket(A));
        net.frame_gone(B);
        net.forget(B);
        assert!(now.open(A, Kind::Socket, None, noop()).is_ok());
        assert!(net.open(A, Kind::Socket, None, noop()).is_ok());
    }

    #[test]
    fn api_forget_cancels_with_stopped() {
        let api = ApiState::default();
        let (cancel, fired) = recorder();
        let _running = api.net().open(A, Kind::Socket, None, cancel).unwrap();
        api.forget(A);
        assert_eq!(*fired.lock().unwrap(), [EndReason::Stopped]);
        assert_eq!(api.net().running(A, Kind::Socket), 0);
    }

    #[test]
    fn a_callback_may_reenter_the_state() {
        let net = NetState::default();
        let inner = net.clone();
        let cancel: CancelFn = Box::new(move |_| {
            inner.record(
                A,
                NetLogEntry::new(LogKind::Fetch, "GET", &url("https://a.example/"), 1),
            );
        });
        let _running = net.open(A, Kind::Fetch, None, cancel).unwrap();
        net.frame_gone(A);
        assert_eq!(net.log(A).len(), 1);
    }

    #[test]
    fn the_reasons_have_their_wire_names() {
        let error = EndReason::FrameGone.error().unwrap();
        assert_eq!(error.code, ApiCode::Aborted);
        assert_eq!(error.reason, Some("frame_gone"));
        assert_eq!(EndReason::Abort.reason(), Some("abort"));
        assert_eq!(EndReason::Stopped.reason(), Some("stopped"));
        assert_eq!(EndReason::Finished.error(), None);
    }

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn the_log_keeps_the_last_200_per_plugin() {
        let net = NetState::default();
        for at in 0..250 {
            net.record(
                A,
                NetLogEntry::new(LogKind::Fetch, "GET", &url("https://a.example/"), at),
            );
        }
        net.record(
            B,
            NetLogEntry::new(LogKind::Socket, "GET", &url("wss://b.example/"), 7),
        );
        let log = net.log(A);
        assert_eq!(log.len(), LOG_CAPACITY);
        assert_eq!(log.first().map(|e| e.at_ms), Some(50));
        assert_eq!(log.last().map(|e| e.at_ms), Some(249));
        assert_eq!(net.log(B).len(), 1);
        assert!(net.log("com.example.none").is_empty());
        // Forgetting a plugin keeps its log.
        net.forget(A);
        assert_eq!(net.log(A).len(), LOG_CAPACITY);
    }

    #[test]
    fn a_log_entry_holds_no_path_query_or_credentials() {
        let mut entry = NetLogEntry::new(
            LogKind::Fetch,
            "POST",
            &url("https://user:secret@api.example.com:8443/v1/items?token=abc#frag"),
            1,
        );
        entry.status = Some(201);
        entry.error = Some("network/closed".into());
        assert_eq!(entry.origin(), "https://api.example.com:8443");
        let text = serde_json::to_string(&entry).unwrap();
        for leak in ["v1", "items", "token", "abc", "frag", "user", "secret"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(json["kind"], "fetch");
        assert_eq!(json["origin"], "https://api.example.com:8443");
        assert_eq!(json["status"], 201);
        // The default port is not written.
        let entry = NetLogEntry::new(LogKind::Stream, "GET", &url("https://a.example:443/x"), 1);
        assert_eq!(entry.origin(), "https://a.example");
    }
}
