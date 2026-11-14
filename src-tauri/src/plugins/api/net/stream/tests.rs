// The stream engine against a local server on 127.0.0.1. Test names resolve through a scripted lookup,
// and 127.0.0.1 counts as public only under `test_allowed`, so nothing here reaches another host. The
// idle and stall timers read a test clock, so no test waits them out.

// -- Library Imports --
use std::net::{IpAddr, Ipv4Addr};

// -- Local Imports --
use super::super::address;
use super::super::fetch::RedirectMode;
use super::super::proxy::{Answer, ScriptedSource, TestClock, UserProxy};
use super::super::sink::RecordingSink;
use super::super::state::{Kind, LogKind};
use super::super::test_server::{pattern, ScriptedLookup, TestCa, TestServer, STALL_PIECE};
use super::super::PROXY;
use super::*;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::state::ApiState;
use crate::plugins::api::MAX_IN_FLIGHT;

const ID: &str = "com.example.net";
const OTHER: &str = "com.example.other";
const A: &str = "a.plisto-fixture.com";
const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const USER_AGENT: &str = "Plisto/2.7.0 (com.example.net/1.0.0)";
const MIB: u64 = 1_048_576;

fn test_allowed(ip: IpAddr) -> bool {
    ip == LOOPBACK || address::allowed(ip)
}

type Code = (ApiCode, Option<&'static str>);

fn code<T: std::fmt::Debug>(result: &Result<T, ApiError>) -> Code {
    match result {
        Ok(value) => panic!("expected an error, got {value:?}"),
        Err(error) => (error.code, error.reason),
    }
}

/// Polls `check` until it holds, for up to 10 s.
async fn until(mut check: impl FnMut() -> bool) -> bool {
    for _ in 0..500 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

/// The most one read can carry past `STREAM_BUFFER`.
const READ_SLACK: usize = STREAM_CHUNK;

/// Polls `read` until it returns the same value 25 times in a row, and returns that value. Call it
/// only once the reader has stopped reading, so the value can no longer be on its way up.
async fn settled(read: impl Fn() -> usize) -> usize {
    let mut last = read();
    let mut same = 0;
    for _ in 0..1_000 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let now = read();
        same = if now == last { same + 1 } else { 0 };
        last = now;
        if same == 25 {
            return now;
        }
    }
    panic!("never settled: {last}");
}

fn is_last(kind: &StreamEventKind) -> bool {
    matches!(kind, StreamEventKind::End | StreamEventKind::Error { .. })
}

struct Fixture {
    ca: TestCa,
    server: TestServer,
    lookup: Arc<ScriptedLookup>,
    clients: Clients,
    net: NetState,
    streams: Streams,
    clock: Arc<TestClock>,
    sink: Arc<RecordingSink>,
    origins: Vec<String>,
}

impl Fixture {
    async fn new() -> Fixture {
        Fixture::with_sink(RecordingSink::default()).await
    }

    async fn with_sink(sink: RecordingSink) -> Fixture {
        let ca = TestCa::new();
        let server = TestServer::tls(&ca, &[A]).await;
        let lookup = Arc::new(ScriptedLookup::default());
        lookup.answer(A, &[&[LOOPBACK]]);
        let clock = Arc::new(TestClock::new());
        Fixture {
            clients: Clients::for_tests(lookup.clone(), test_allowed, ca.root()),
            origins: vec![format!("https://{A}:{}", server.port)],
            ca,
            server,
            lookup,
            net: NetState::default(),
            streams: Streams::new(clock.clone()),
            clock,
            sink: Arc::new(sink),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("https://{A}:{}{path}", self.server.port)
    }

    fn consent(&self) -> Consent<'_> {
        Consent {
            origins: &self.origins,
            dev_mode: false,
        }
    }

    async fn open_with(
        &self,
        net: &NetState,
        request: StreamRequest,
    ) -> Result<StreamOpened, ApiError> {
        let sink: Arc<dyn NetSink> = self.sink.clone();
        let consent = self.consent();
        open(
            &self.clients,
            net,
            &self.streams,
            sink,
            ID,
            consent,
            request,
        )
        .await
    }

    async fn open(&self, request: StreamRequest) -> Result<StreamOpened, ApiError> {
        self.open_with(&self.net, request).await
    }

    async fn open_path(&self, path: &str) -> String {
        let opened = self.open(request(self.url(path))).await.unwrap();
        assert_eq!(opened.status, 200);
        opened.stream.unwrap()
    }

    fn events(&self, stream: &str) -> Vec<StreamEventKind> {
        self.sink.stream_events(stream)
    }

    fn probe(&self, stream: &str) -> Probe {
        self.streams.probe(stream).unwrap_or_default()
    }

    /// Waits until the reader holds a full buffer and has stopped reading.
    async fn paused(&self, stream: &str) {
        assert!(until(|| self.probe(stream).buffered >= STREAM_BUFFER).await);
    }

    /// Waits until the reader has run two more timer checks, so it has seen the clock as it is now.
    async fn checked(&self, stream: &str) {
        let from = self.probe(stream).checks;
        assert!(until(|| self.probe(stream).checks >= from + 2).await);
    }

    fn running_on(&self, stream: &str) -> bool {
        self.events(stream).iter().all(|k| !is_last(k))
    }

    /// Polls `check` until it holds, moving the clock one coalesce interval each time so bytes that
    /// wait for a full chunk are emitted.
    async fn flushed(&self, mut check: impl FnMut() -> bool) -> bool {
        for _ in 0..500 {
            if check() {
                return true;
            }
            self.clock.advance(STREAM_COALESCE);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    async fn first_chunk(&self, stream: &str) {
        assert!(self.flushed(|| self.sink.chunk_bytes(stream) > 0).await);
    }

    fn body(&self, stream: &str) -> Vec<u8> {
        let mut body = Vec::new();
        for event in self.events(stream) {
            if let StreamEventKind::Chunk { data_b64, .. } = event {
                body.extend(STANDARD.decode(data_b64).unwrap());
            }
        }
        body
    }

    /// Waits for `stream`'s last event, checks it is its one end or error, and returns it.
    async fn ended(&self, stream: &str) -> StreamEventKind {
        assert!(until(|| self.events(stream).iter().any(is_last)).await);
        let events = self.events(stream);
        assert_eq!(events.iter().filter(|k| is_last(k)).count(), 1);
        assert!(!self.streams.table().contains_key(stream));
        let last = events.last().cloned().unwrap();
        assert!(is_last(&last), "the end is not the last event: {last:?}");
        last
    }

    async fn ended_with(&self, stream: &str) -> Code {
        match self.ended(stream).await {
            StreamEventKind::Error { code, reason } => (code, reason),
            other => panic!("expected an error, got {other:?}"),
        }
    }

    /// Acknowledges everything emitted until the stream ends, and returns the body.
    async fn read_all(&self, stream: &str) -> Vec<u8> {
        loop {
            let _ = ack(&self.streams, ID, stream, self.sink.chunk_bytes(stream));
            if self.events(stream).iter().any(is_last) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let mut body = Vec::new();
        for event in self.events(stream) {
            if let StreamEventKind::Chunk { data_b64, .. } = event {
                body.extend(STANDARD.decode(data_b64).unwrap());
            }
        }
        body
    }
}

fn fetch(url: String) -> FetchRequest {
    FetchRequest {
        url,
        method: Method::Get,
        headers: Vec::new(),
        body: Vec::new(),
        redirect: RedirectMode::Follow,
        timeout: Duration::from_secs(10),
        abort_key: None,
        user_agent: USER_AGENT.to_string(),
    }
}

fn request(url: String) -> StreamRequest {
    StreamRequest {
        fetch: fetch(url),
        idle: idle_timeout(None).unwrap(),
    }
}

fn idle(url: String, idle_ms: u64) -> StreamRequest {
    StreamRequest {
        idle: idle_timeout(Some(idle_ms)).unwrap(),
        ..request(url)
    }
}

// ---- Chunks ----

#[tokio::test(flavor = "multi_thread")]
async fn chunks_arrive_in_order_at_most_64_kib_with_bytes_intact() {
    let fx = Fixture::new().await;
    let len = 3 * MIB as usize + 12_345;
    let stream = fx.open_path(&format!("/fast-stream?len={len}")).await;
    assert!(stream.starts_with('t'));
    let body = fx.read_all(&stream).await;
    assert_eq!(body, pattern(len));

    // Full chunks while the body flows, then the remainder, flushed before `end`.
    let events = fx.events(&stream);
    assert_eq!(events.last(), Some(&StreamEventKind::End));
    let chunks = events.len() - 1;
    for (i, event) in events[..chunks].iter().enumerate() {
        let StreamEventKind::Chunk { seq, data_b64 } = event else {
            panic!("not a chunk: {event:?}");
        };
        assert_eq!(*seq, i as u64 + 1);
        let size = STANDARD.decode(data_b64).unwrap().len();
        let full = if i + 1 == chunks {
            len % STREAM_CHUNK
        } else {
            STREAM_CHUNK
        };
        assert_eq!(size, full, "chunk {}", i + 1);
    }
    assert!(until(|| fx.net.running(ID, Kind::Stream) == 0).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn redirects_are_followed_before_the_stream_opens() {
    let fx = Fixture::new().await;
    let opened = fx.open(request(fx.url("/redirect/2"))).await.unwrap();
    assert!(opened.redirected);
    assert_eq!(opened.url.as_str(), fx.url("/redirect/0"));
    let stream = opened.stream.unwrap();
    assert_eq!(fx.read_all(&stream).await, b"done");
    assert_eq!(fx.server.heads().len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn server_sent_events_arrive_as_sent() {
    let fx = Fixture::new().await;
    let opened = fx
        .open(StreamRequest {
            fetch: FetchRequest {
                headers: vec![("last-event-id".into(), "5".into())],
                ..fetch(fx.url("/sse"))
            },
            ..request(String::new())
        })
        .await
        .unwrap();
    let stream = opened.stream.unwrap();
    let text = || String::from_utf8(fx.body(&stream)).unwrap();
    assert!(fx.flushed(|| text().contains("data: tick 7\n\n")).await);
    assert!(text().starts_with("retry: 1000\n\nid: 6\ndata: tick 6\n\n"));
    cancel(&fx.streams, ID, &stream).unwrap();
    assert_eq!(
        fx.ended_with(&stream).await,
        (ApiCode::Aborted, Some("abort"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_response_without_a_body_opens_no_stream() {
    let fx = Fixture::new().await;
    for status in [204, 304] {
        let opened = fx
            .open(request(fx.url(&format!("/status/{status}"))))
            .await
            .unwrap();
        assert_eq!(opened.status, status);
        assert_eq!(opened.stream, None);
    }
    assert_eq!(fx.net.running(ID, Kind::Stream), 0);
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);
    assert_eq!(fx.streams.len(), 0);
    let log = fx.net.log(ID);
    assert_eq!(log.len(), 2);
    assert!(log
        .iter()
        .all(|e| e.kind == LogKind::Stream && e.error.is_none()));
    assert!(fx.sink.events().is_empty());

    let head = StreamRequest {
        fetch: FetchRequest {
            method: Method::Head,
            ..fetch(fx.url("/bin"))
        },
        ..request(String::new())
    };
    assert_eq!(code(&fx.open(head).await), (ApiCode::InvalidArgs, None));
    assert_eq!(fx.server.connections(), 2);
}

#[test]
fn idle_must_be_in_range() {
    assert_eq!(idle_timeout(None).unwrap(), Duration::from_secs(60));
    assert_eq!(idle_timeout(Some(5_000)).unwrap(), Duration::from_secs(5));
    assert!(idle_timeout(Some(600_000)).is_ok());
    for out in [4_999, 600_001] {
        assert_eq!(code(&idle_timeout(Some(out))), (ApiCode::InvalidArgs, None));
    }
}

// ---- Window and buffer ----

#[tokio::test(flavor = "multi_thread")]
async fn with_no_ack_emission_stops_at_the_window_and_the_server_is_slowed() {
    let fx = Fixture::new().await;
    let stream = fx.open_path("/fast-stream").await;
    fx.paused(&stream).await;
    assert_eq!(fx.sink.chunk_bytes(&stream), STREAM_WINDOW);
    let written = settled(|| fx.server.streamed()).await;
    assert!(
        written >= STREAM_WINDOW as usize + STREAM_BUFFER,
        "{written}"
    );
    let probe = fx.probe(&stream);
    assert!(
        probe.peak_buffered <= STREAM_BUFFER + READ_SLACK,
        "{probe:?}"
    );
    assert!(
        probe.peak_capacity <= STREAM_BUFFER + READ_SLACK,
        "{probe:?}"
    );
    assert_eq!(fx.sink.chunk_bytes(&stream), STREAM_WINDOW);

    ack(&fx.streams, ID, &stream, STREAM_WINDOW).unwrap();
    assert!(until(|| fx.sink.chunk_bytes(&stream) == 2 * STREAM_WINDOW).await);
    assert!(until(|| fx.server.streamed() > written).await);
    assert_eq!(fx.sink.chunk_bytes(&stream), 2 * STREAM_WINDOW);
    assert!(fx.events(&stream).iter().all(|k| !is_last(k)));

    cancel(&fx.streams, ID, &stream).unwrap();
    assert!(fx.server.saw_close(1).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ack_must_not_go_back_or_pass_what_was_sent() {
    let fx = Fixture::new().await;
    let stream = fx.open_path("/fast-stream").await;
    assert!(until(|| fx.sink.chunk_bytes(&stream) == STREAM_WINDOW).await);
    let over = ack(&fx.streams, ID, &stream, STREAM_WINDOW + 1);
    assert_eq!(code(&over), (ApiCode::InvalidArgs, None));
    ack(&fx.streams, ID, &stream, 1_000).unwrap();
    ack(&fx.streams, ID, &stream, 1_000).unwrap();
    let back = ack(&fx.streams, ID, &stream, 999);
    assert_eq!(code(&back), (ApiCode::InvalidArgs, None));

    let foreign = ack(&fx.streams, OTHER, &stream, 2_000);
    assert_eq!(code(&foreign), (ApiCode::NotFound, None));
    assert_eq!(
        code(&ack(&fx.streams, ID, "t0", 0)),
        (ApiCode::NotFound, None)
    );
    assert_eq!(
        code(&cancel(&fx.streams, OTHER, &stream)),
        (ApiCode::NotFound, None)
    );
    assert!(fx.events(&stream).iter().all(|k| !is_last(k)));

    cancel(&fx.streams, ID, &stream).unwrap();
    fx.ended(&stream).await;
    assert_eq!(
        code(&ack(&fx.streams, ID, &stream, 2_000)),
        (ApiCode::NotFound, None)
    );
    assert_eq!(
        code(&cancel(&fx.streams, ID, &stream)),
        (ApiCode::NotFound, None)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_of_1_byte_chunks_is_held_in_one_buffer() {
    let fx = Fixture::new().await;
    // The prefix fills the window, so every 1-byte chunk after it is buffered.
    let stream = fx
        .open_path(&format!("/tiny-stream?prefix={STREAM_WINDOW}"))
        .await;
    let held = 16 * 1024;
    assert!(until(|| fx.sink.chunk_bytes(&stream) == STREAM_WINDOW).await);
    assert!(until(|| fx.probe(&stream).buffered >= held).await);
    let probe = fx.probe(&stream);
    // One growing allocation: at most twice what it holds, never one per chunk.
    assert!(probe.peak_capacity <= 2 * probe.peak_buffered, "{probe:?}");
    assert_eq!(fx.sink.chunk_bytes(&stream), STREAM_WINDOW);

    ack(&fx.streams, ID, &stream, STREAM_WINDOW).unwrap();
    let wanted = STREAM_WINDOW + held as u64;
    assert!(fx.flushed(|| fx.sink.chunk_bytes(&stream) >= wanted).await);
    let body = fx.body(&stream);
    assert_eq!(body, pattern(body.len()));
    cancel(&fx.streams, ID, &stream).unwrap();
    assert!(fx.server.saw_close(1).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn tiny_chunks_cost_at_most_one_event_per_coalesce_interval() {
    let fx = Fixture::new().await;
    let stream = fx.open_path("/tiny-stream").await;
    let intervals = 100;
    for _ in 0..intervals {
        fx.clock.advance(STREAM_COALESCE);
        let _ = ack(&fx.streams, ID, &stream, fx.sink.chunk_bytes(&stream));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let events = fx.events(&stream).len();
    let bytes = fx.sink.chunk_bytes(&stream) as usize;
    // One second on the clock: at most one event per interval, however many chunks arrived.
    assert!(events <= intervals, "{events} events");
    assert!(bytes >= 10 * events, "{bytes} bytes in {events} events");
    assert_eq!(fx.body(&stream), pattern(bytes));
    cancel(&fx.streams, ID, &stream).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_short_write_is_emitted_once_its_coalesce_interval_passes() {
    let fx = Fixture::new().await;
    let stream = fx.open_path("/sse").await;
    assert!(until(|| fx.probe(&stream).buffered > 0).await);
    fx.checked(&stream).await;
    assert_eq!(fx.sink.chunk_bytes(&stream), 0);

    fx.clock.advance(STREAM_COALESCE);
    assert!(until(|| fx.sink.chunk_bytes(&stream) > 0).await);
    assert!(String::from_utf8(fx.body(&stream))
        .unwrap()
        .starts_with("retry: 1000\n\n"));
    assert!((fx.sink.chunk_bytes(&stream) as usize) < STREAM_CHUNK);
    cancel(&fx.streams, ID, &stream).unwrap();
}

#[test]
fn the_buffer_keeps_order_across_its_wrap_and_never_grows_past_the_cap() {
    let mut buffer = Buffer::default();
    let source = pattern(STREAM_BUFFER + 300);
    let now = Instant::now();
    for byte in source[..STREAM_BUFFER].chunks(1) {
        buffer.push(byte, now);
    }
    assert_eq!(buffer.due_at(), Some(now + STREAM_COALESCE));
    assert_eq!(buffer.capacity(), STREAM_BUFFER);
    assert_eq!(buffer.take(STREAM_CHUNK), source[..STREAM_CHUNK]);
    buffer.push(&source[STREAM_BUFFER..], now + STREAM_COALESCE);
    assert_eq!(buffer.capacity(), STREAM_BUFFER);
    let rest = buffer.take(buffer.len());
    assert_eq!(rest, source[STREAM_CHUNK..]);
    assert_eq!(buffer.len(), 0);
}

// ---- Timers ----

#[tokio::test(flavor = "multi_thread")]
async fn data_waiting_on_a_page_that_acks_nothing_for_60_s_is_stalled() {
    let fx = Fixture::new().await;
    let stream = fx
        .open(idle(fx.url("/fast-stream"), IDLE_MAX_MS))
        .await
        .unwrap()
        .stream
        .unwrap();
    assert!(until(|| fx.sink.chunk_bytes(&stream) == STREAM_WINDOW).await);
    fx.clock.advance(Duration::from_millis(STALL_MS));
    let got = fx.ended_with(&stream).await;
    assert_eq!(got, (ApiCode::Network, Some(STALLED)));
    assert!(fx.server.saw_close(1).await);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/stalled"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_that_receives_nothing_for_its_idle_time_is_idle() {
    let fx = Fixture::new().await;
    let stream = fx
        .open(idle(fx.url("/stall-stream"), IDLE_MIN_MS))
        .await
        .unwrap()
        .stream
        .unwrap();
    assert!(
        fx.flushed(|| fx.sink.chunk_bytes(&stream) == STALL_PIECE as u64)
            .await
    );
    ack(&fx.streams, ID, &stream, STALL_PIECE as u64).unwrap();
    fx.clock.advance(Duration::from_millis(IDLE_MIN_MS));
    assert_eq!(fx.ended_with(&stream).await, (ApiCode::Timeout, Some(IDLE)));
    assert!(fx.server.saw_close(1).await);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("timeout/idle"));
    assert_eq!(entry.received, STALL_PIECE as u64);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_30_minute_stream_of_100_mib_ends_only_on_cancel() {
    let fx = Fixture::with_sink(RecordingSink::dropping_data()).await;
    // At most 5 MiB can pass with no read, under 90 simulated seconds: inside the longest idle time.
    let stream = fx
        .open(idle(fx.url("/fast-stream"), IDLE_MAX_MS))
        .await
        .unwrap()
        .stream
        .unwrap();
    let total = 100 * MIB;
    let per_mib = Duration::from_secs(30 * 60) / 100;
    let mut acked = 0;
    while acked < total {
        let emitted = fx.sink.chunk_bytes(&stream);
        if emitted > acked {
            ack(&fx.streams, ID, &stream, emitted).unwrap();
            fx.clock
                .advance(per_mib.mul_f64((emitted - acked) as f64 / MIB as f64));
            acked = emitted;
        }
        assert!(fx.events(&stream).iter().all(|k| !is_last(k)));
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    cancel(&fx.streams, ID, &stream).unwrap();
    assert_eq!(
        fx.ended_with(&stream).await,
        (ApiCode::Aborted, Some("abort"))
    );
    assert!(fx.server.saw_close(1).await);
    let entry = fx.net.log(ID).pop().unwrap();
    assert!(entry.received >= total);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_an_ack_that_moves_resets_the_stall_timer() {
    let fx = Fixture::new().await;
    let stream = fx
        .open(idle(fx.url("/fast-stream"), IDLE_MAX_MS))
        .await
        .unwrap()
        .stream
        .unwrap();
    assert!(until(|| fx.sink.chunk_bytes(&stream) == STREAM_WINDOW).await);
    let half = Duration::from_millis(STALL_MS / 2);
    fx.clock.advance(half);
    ack(&fx.streams, ID, &stream, 1_000).unwrap();
    fx.clock.advance(half);
    fx.checked(&stream).await;
    assert!(fx.running_on(&stream));

    ack(&fx.streams, ID, &stream, 1_000).unwrap();
    fx.clock.advance(half);
    assert_eq!(
        fx.ended_with(&stream).await,
        (ApiCode::Network, Some(STALLED))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn time_spent_with_a_full_buffer_is_not_idle() {
    let fx = Fixture::new().await;
    let stream = fx
        .open(idle(fx.url("/fast-stream"), IDLE_MIN_MS))
        .await
        .unwrap()
        .stream
        .unwrap();
    fx.paused(&stream).await;
    fx.clock.advance(Duration::from_millis(STALL_MS / 2));
    fx.checked(&stream).await;
    assert!(fx.running_on(&stream));

    let written = fx.server.streamed();
    ack(&fx.streams, ID, &stream, STREAM_WINDOW).unwrap();
    assert!(until(|| fx.server.streamed() > written).await);
    fx.checked(&stream).await;
    assert!(fx.running_on(&stream));
    cancel(&fx.streams, ID, &stream).unwrap();
    assert_eq!(
        fx.ended_with(&stream).await,
        (ApiCode::Aborted, Some("abort"))
    );
}

// ---- Cancellation ----

/// Opens a `/stream` with abort key `key`, waits for its first chunk, ends it with `end`, and returns
/// how it ended.
async fn end_mid_stream(fx: &Fixture, key: &str, end: impl FnOnce(&str)) -> Code {
    let request = StreamRequest {
        fetch: FetchRequest {
            abort_key: Some(key.to_string()),
            ..fetch(fx.url("/stream"))
        },
        ..request(String::new())
    };
    let stream = fx.open(request).await.unwrap().stream.unwrap();
    fx.first_chunk(&stream).await;
    assert_eq!(fx.net.running(ID, Kind::Stream), 1);
    end(&stream);
    assert_eq!(fx.net.running(ID, Kind::Stream), 0);
    fx.ended_with(&stream).await
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_abort_key_frame_events_and_forget_end_the_stream_and_close_it() {
    type Ender<'a> = Box<dyn Fn(&str) + 'a>;
    let fx = Fixture::new().await;
    let ends: [(&str, Ender, &str); 4] = [
        (
            "k1",
            Box::new(|stream| cancel(&fx.streams, ID, stream).unwrap()),
            "abort",
        ),
        (
            "k2",
            Box::new(|_| assert_eq!(fx.net.abort(ID, "k2"), 1)),
            "abort",
        ),
        ("k3", Box::new(|_| fx.net.frame_gone(ID)), "frame_gone"),
        ("k4", Box::new(|_| fx.net.forget(ID)), "stopped"),
    ];
    for (n, (key, end, reason)) in ends.into_iter().enumerate() {
        let got = end_mid_stream(&fx, key, end).await;
        assert_eq!(got, (ApiCode::Aborted, Some(reason)));
        assert!(fx.server.saw_close(n + 1).await, "{reason}");
    }
    let log = fx.net.log(ID);
    assert_eq!(log.len(), 4);
    for (entry, reason) in log.iter().zip(["abort", "abort", "frame_gone", "stopped"]) {
        assert_eq!(entry.kind, LogKind::Stream);
        assert_eq!(entry.status, Some(200));
        assert_eq!(
            entry.error.as_deref(),
            Some(format!("aborted/{reason}").as_str())
        );
        assert!(entry.received > 0);
    }
    assert_eq!(fx.streams.len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_headers_timeout_and_a_cancel_before_the_headers_leave_no_entry() {
    let fx = Fixture::new().await;
    let slow = StreamRequest {
        fetch: FetchRequest {
            timeout: Duration::from_millis(300),
            ..fetch(fx.url("/hang"))
        },
        ..request(String::new())
    };
    assert_eq!(code(&fx.open(slow).await), (ApiCode::Timeout, None));
    assert!(fx.server.saw_close(1).await);
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);
    assert_eq!(fx.net.running(ID, Kind::Stream), 0);

    let keyed = StreamRequest {
        fetch: FetchRequest {
            abort_key: Some("k".into()),
            ..fetch(fx.url("/hang"))
        },
        ..request(String::new())
    };
    let ender = async {
        assert!(until(|| fx.server.heads().len() == 2).await);
        assert_eq!(fx.net.running(ID, Kind::Fetch), 1);
        assert_eq!(fx.net.running(ID, Kind::Stream), 1);
        assert_eq!(fx.net.abort(ID, "k"), 2);
    };
    let (got, ()) = tokio::join!(fx.open(keyed), ender);
    assert_eq!(code(&got), (ApiCode::Aborted, Some("abort")));
    assert!(fx.server.saw_close(2).await);
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);
    assert_eq!(fx.net.running(ID, Kind::Stream), 0);
    assert_eq!(fx.streams.len(), 0);
    let log = fx.net.log(ID);
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].error.as_deref(), Some("timeout"));
    assert!(fx.sink.events().is_empty());
}

// ---- Caps ----

#[tokio::test(flavor = "multi_thread")]
async fn a_third_stream_is_busy_and_open_streams_hold_no_in_flight_slot() {
    let fx = Fixture::new().await;
    let api = ApiState::default();
    let first = fx.open_with(api.net(), request(fx.url("/stream"))).await;
    let first = first.unwrap().stream.unwrap();
    fx.open_with(api.net(), request(fx.url("/stream")))
        .await
        .unwrap();
    let third = fx.open_with(api.net(), request(fx.url("/stream"))).await;
    assert_eq!(code(&third), (ApiCode::Busy, None));
    assert_eq!(fx.server.connections(), 2);

    assert_eq!(api.net().running(ID, Kind::Fetch), 0);
    assert_eq!(api.in_flight(ID), 0);
    let calls: Vec<_> = (0..MAX_IN_FLIGHT).map(|_| api.enter(ID).unwrap()).collect();
    assert_eq!(calls.len(), MAX_IN_FLIGHT as usize);
    // The stream cap is checked before anything is sent.
    let bodiless = fx
        .open_with(api.net(), request(fx.url("/status/204")))
        .await;
    assert_eq!(code(&bodiless), (ApiCode::Busy, None));
    assert_eq!(fx.server.connections(), 2);

    cancel(&fx.streams, ID, &first).unwrap();
    assert_eq!(api.net().running(ID, Kind::Stream), 1);
    fx.open_with(api.net(), request(fx.url("/stream")))
        .await
        .unwrap();
    api.forget(ID);
    assert!(until(|| fx.streams.len() == 0).await);
}

// ---- Ends ----

#[tokio::test(flavor = "multi_thread")]
async fn a_panicking_reader_still_ends_its_stream_once() {
    let fx = Fixture::with_sink(RecordingSink::panicking_on_message()).await;
    let stream = fx.open_path("/stream").await;
    assert!(fx.flushed(|| !fx.events(&stream).is_empty()).await);
    let got = fx.ended_with(&stream).await;
    assert_eq!(got, (ApiCode::Network, Some(CLOSED)));
    assert_eq!(fx.events(&stream).len(), 1);
    assert_eq!(fx.net.running(ID, Kind::Stream), 0);
    assert!(fx.server.saw_close(1).await);
    assert_eq!(fx.net.log(ID).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_connection_is_closed_and_a_proxy_names_it() {
    let fx = Fixture::new().await;
    let stream = fx.open_path("/sse-drop").await;
    assert_eq!(
        fx.ended_with(&stream).await,
        (ApiCode::Network, Some(CLOSED))
    );
    // The events waited to coalesce, and an error flushes nothing.
    assert_eq!(fx.events(&stream).len(), 1);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/closed"));

    let manual = Answer {
        user: UserProxy {
            proxy: true,
            ..UserProxy::default()
        },
        ..Answer::default()
    };
    let proxy = Proxy::new(Arc::new(ScriptedSource::new(manual)), Arc::new(SystemClock));
    let mut fx = fx;
    fx.clients =
        Clients::for_tests(fx.lookup.clone(), test_allowed, fx.ca.root()).with_proxy(proxy);
    let stream = fx.open_path("/sse-drop").await;
    assert_eq!(
        fx.ended_with(&stream).await,
        (ApiCode::Network, Some(PROXY))
    );
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/closed+proxy"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transport_failure_ends_at_once_without_the_buffered_data() {
    let fx = Fixture::new().await;
    let len = 3 * MIB as usize;
    let stream = fx.open_path(&format!("/fast-drop?len={len}")).await;
    assert_eq!(
        fx.ended_with(&stream).await,
        (ApiCode::Network, Some(CLOSED))
    );
    assert_eq!(fx.sink.chunk_bytes(&stream), STREAM_WINDOW);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.received, len as u64);
    assert_eq!(entry.error.as_deref(), Some("network/closed"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_log_entry_is_written_once_when_the_stream_ends() {
    let fx = Fixture::new().await;
    let stream = fx.open_path("/fast-stream?len=100000").await;
    fx.read_all(&stream).await;
    assert_eq!(fx.ended(&stream).await, StreamEventKind::End);
    let log = fx.net.log(ID);
    assert_eq!(log.len(), 1);
    let entry = &log[0];
    assert_eq!(entry.kind, LogKind::Stream);
    assert_eq!(entry.method, "GET");
    assert_eq!(entry.origin(), fx.origins[0]);
    assert_eq!(entry.status, Some(200));
    assert_eq!(entry.error, None);
    assert_eq!(entry.received, 100_000);
}

// ---- Shared head ----

#[tokio::test(flavor = "multi_thread")]
async fn open_streamed_returns_the_head_with_the_fetch_slot_released() {
    let fx = Fixture::new().await;
    let request = fetch(fx.url("/stream"));
    let head = open_streamed(
        &fx.clients,
        &fx.net,
        ID,
        fx.consent(),
        &request,
        StreamKind::Page,
    )
    .await
    .unwrap();
    assert_eq!(head.status, 200);
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);
    assert_eq!(fx.net.running(ID, Kind::Stream), 1);
    let mut body = head.body.unwrap();
    assert!(body.response.chunk().await.unwrap().is_some());
    body.finish(&fx.net, ID, None, None);
    assert_eq!(fx.net.running(ID, Kind::Stream), 0);
    assert!(fx.server.saw_close(1).await);
    assert_eq!(fx.net.log(ID).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_playback_head_outlives_frame_events_forget_and_a_page_abort() {
    let fx = Fixture::new().await;
    let request = FetchRequest {
        abort_key: Some("k".into()),
        timeout: Duration::from_secs(1),
        ..fetch(fx.url("/hang"))
    };
    let opening = open_streamed(
        &fx.clients,
        &fx.net,
        ID,
        fx.consent(),
        &request,
        StreamKind::Playback,
    );
    let ender = async {
        assert!(until(|| fx.server.heads().len() == 1).await);
        fx.net.frame_gone(ID);
        fx.net.forget(ID);
        assert_eq!(fx.net.abort(ID, "k"), 0);
        assert_eq!(fx.net.running(ID, Kind::Fetch), 1);
        assert_eq!(fx.net.running(ID, Kind::Playback), 1);
    };
    let (got, ()) = tokio::join!(opening, ender);
    // Still waiting on its headers when its own deadline passed: nothing above ended it.
    assert_eq!(code(&got.map(|head| head.status)), (ApiCode::Timeout, None));
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);
    assert_eq!(fx.net.running(ID, Kind::Playback), 0);
    assert_eq!(fx.net.log(ID).pop().unwrap().kind, LogKind::Playback);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_playback_stream_outlives_frame_events_and_forget_and_ends_on_its_own_cancel() {
    let fx = Fixture::new().await;
    let request = FetchRequest {
        abort_key: Some("k".into()),
        ..fetch(fx.url("/stream"))
    };
    let head = open_streamed(
        &fx.clients,
        &fx.net,
        ID,
        fx.consent(),
        &request,
        StreamKind::Playback,
    )
    .await
    .unwrap();
    let mut body = head.body.unwrap();
    fx.net.frame_gone(ID);
    fx.net.forget(ID);
    assert_eq!(fx.net.abort(ID, "k"), 0);
    assert_eq!(fx.net.running(ID, Kind::Playback), 1);
    assert!(body.ended.wait().now_or_never().is_none());

    assert!(fx.net.end(body.running.key(), EndReason::Stopped));
    let error = body.ended.wait().await;
    assert_eq!(
        (error.code, error.reason),
        (ApiCode::Aborted, Some("stopped"))
    );
    assert_eq!(fx.net.running(ID, Kind::Playback), 0);
    body.finish(&fx.net, ID, Some(&error), None);
    assert!(fx.server.saw_close(1).await);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.kind, LogKind::Playback);
    assert_eq!(entry.error.as_deref(), Some("aborted/stopped"));
}
