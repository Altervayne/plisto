// The socket engine against a local server on 127.0.0.1. Test names resolve through a scripted lookup,
// and 127.0.0.1 counts as public only under `test_allowed`, so nothing here reaches another host.

// -- Library Imports --
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;

// -- Local Imports --
use super::super::address;
use super::super::proxy::{Answer, Proxy, ScriptedSource, SystemClock, TestClock, UserProxy};
use super::super::sink::RecordingSink;
use super::super::test_server::{
    pattern, ScriptedLookup, TestCa, TestServer, WS_CLOSE_CODE, WS_CLOSE_REASON,
};
use super::super::{
    BLOCKED_ADDRESS, CONNECT, DEV_ONLY, FORBIDDEN_HEADER, ORIGIN_NOT_LISTED, PROXY,
};
use super::*;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::state::ApiState;
use crate::plugins::api::MAX_IN_FLIGHT;

const ID: &str = "com.example.net";
const OTHER: &str = "com.example.other";
const A: &str = "a.plisto-fixture.com";
const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const PRIVATE: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
const USER_AGENT: &str = "Plisto/2.7.0 (com.example.net/1.0.0)";

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

/// Polls `check` until it holds, for up to 5 s.
async fn until(mut check: impl FnMut() -> bool) -> bool {
    for _ in 0..250 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

struct Fixture {
    server: TestServer,
    lookup: Arc<ScriptedLookup>,
    clients: Clients,
    net: NetState,
    sockets: Sockets,
    /// The clock the stall check reads.
    clock: Arc<TestClock>,
    sink: Arc<RecordingSink>,
    origins: Vec<String>,
    dev_mode: bool,
    /// Sockets opened from now on acknowledge each message as it is emitted.
    acking: bool,
}

impl Fixture {
    async fn new() -> Fixture {
        let ca = TestCa::new();
        let server = TestServer::tls(&ca, &[A]).await;
        Fixture::with(&ca, server)
    }

    fn with(ca: &TestCa, server: TestServer) -> Fixture {
        let lookup = Arc::new(ScriptedLookup::default());
        lookup.answer(A, &[&[LOOPBACK]]);
        let clock = Arc::new(TestClock::new());
        Fixture {
            clients: Clients::for_tests(lookup.clone(), test_allowed, ca.root()),
            origins: vec![format!("https://{A}:{}", server.port)],
            server,
            lookup,
            net: NetState::default(),
            sockets: Sockets::new(clock.clone()),
            clock,
            sink: Arc::new(RecordingSink::default()),
            dev_mode: false,
            acking: false,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("wss://{A}:{}{path}", self.server.port)
    }

    async fn open_with(
        &self,
        net: &NetState,
        request: SocketRequest,
    ) -> Result<SocketOpened, ApiError> {
        self.open_as(ID, net, request).await
    }

    async fn open_as(
        &self,
        id: &str,
        net: &NetState,
        request: SocketRequest,
    ) -> Result<SocketOpened, ApiError> {
        let consent = Consent {
            origins: &self.origins,
            dev_mode: self.dev_mode,
        };
        let sink: Arc<dyn NetSink> = if self.acking {
            Arc::new(AckingSink {
                record: self.sink.clone(),
                sockets: self.sockets.clone(),
                totals: Mutex::default(),
            })
        } else {
            self.sink.clone()
        };
        open(
            &self.clients,
            net,
            &self.sockets,
            sink,
            id,
            consent,
            request,
        )
        .await
    }

    /// The payload bytes `socket` delivered so far.
    fn delivered(&self, socket: &str) -> u64 {
        delivered(&self.sink, socket)
    }

    /// Waits until `socket`'s waiting driver has run two more stall checks, so at least one began
    /// after this call: whatever that check decided is in effect.
    async fn rechecked(&self, socket: &str) {
        let start = self.sockets.checks(socket);
        assert!(until(|| self.sockets.checks(socket) >= start + 2).await);
    }

    async fn open(&self, request: SocketRequest) -> Result<SocketOpened, ApiError> {
        self.open_with(&self.net, request).await
    }

    async fn open_path(&self, path: &str) -> String {
        self.open(request(self.url(path))).await.unwrap().socket
    }

    fn send(&self, socket: &str, message: Outgoing) -> Result<(), ApiError> {
        send(&self.sockets, ID, socket, message)
    }

    /// Waits for `socket`'s `close`, checks it is its one and last event, and returns it.
    async fn ended(&self, socket: &str) -> (u16, String, bool) {
        let closed = |kind: &SocketEventKind| matches!(kind, SocketEventKind::Close { .. });
        assert!(until(|| self.sink.socket_events(socket).iter().any(closed)).await);
        let events = self.sink.socket_events(socket);
        assert_eq!(events.iter().filter(|k| closed(k)).count(), 1);
        assert!(!self.sockets.table().contains_key(socket));
        match events.last() {
            Some(SocketEventKind::Close {
                code,
                reason,
                clean,
            }) => (*code, reason.clone(), *clean),
            other => panic!("the close is not the last event: {other:?}"),
        }
    }
}

/// The payload bytes one socket event carries.
fn payload_len(kind: &SocketEventKind) -> u64 {
    match kind {
        SocketEventKind::Text { data } => data.len() as u64,
        SocketEventKind::Binary { data_b64 } => {
            let padding = data_b64.bytes().rev().take_while(|b| *b == b'=').count();
            (data_b64.len() / 4 * 3 - padding) as u64
        }
        SocketEventKind::Close { .. } => 0,
    }
}

fn delivered(sink: &RecordingSink, socket: &str) -> u64 {
    sink.socket_events(socket).iter().map(payload_len).sum()
}

/// Records like `RecordingSink`, and acknowledges each message as it is emitted, as a page that keeps
/// up would.
struct AckingSink {
    record: Arc<RecordingSink>,
    sockets: Sockets,
    totals: Mutex<HashMap<String, u64>>,
}

impl NetSink for AckingSink {
    fn emit(&self, event: NetEvent) {
        let message = match &event.body {
            super::super::sink::NetEventBody::Socket(socket) => {
                Some((socket.socket.clone(), payload_len(&socket.kind)))
            }
            _ => None,
        };
        let id = event.id.clone();
        self.record.emit(event);
        if let Some((socket, len)) = message {
            let mut totals = self.totals.lock().unwrap();
            let total = totals.entry(socket.clone()).or_default();
            *total += len;
            let _ = ack(&self.sockets, &id, &socket, *total);
        }
    }
}

fn request(url: String) -> SocketRequest {
    SocketRequest {
        url,
        protocols: Vec::new(),
        headers: Vec::new(),
        timeout: Duration::from_secs(10),
        user_agent: USER_AGENT.to_string(),
    }
}

// ---- Messages and closes ----

#[tokio::test(flavor = "multi_thread")]
async fn text_and_binary_echo_and_a_plugin_close_completes_cleanly() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws").await;
    assert!(socket.starts_with('s'));
    fx.send(&socket, Outgoing::Text("hello".into())).unwrap();
    fx.send(&socket, Outgoing::Binary(pattern(1000))).unwrap();
    assert!(until(|| fx.sink.socket_events(&socket).len() == 2).await);
    let events = fx.sink.socket_events(&socket);
    assert_eq!(
        events[0],
        SocketEventKind::Text {
            data: "hello".into()
        }
    );
    assert_eq!(
        events[1],
        SocketEventKind::Binary {
            data_b64: STANDARD.encode(pattern(1000))
        }
    );
    assert!(fx.sink.events().iter().all(|e| e.id == ID));

    close(&fx.sockets, ID, &socket, Some(4000), "bye").unwrap();
    assert_eq!(fx.ended(&socket).await, (4000, "bye".into(), true));
    assert!(fx.server.saw_ws_close(4000).await);
    let gone = fx.send(&socket, Outgoing::Text("late".into()));
    assert_eq!(code(&gone), (ApiCode::NotFound, None));
    assert!(until(|| fx.net.running(ID, Kind::Socket) == 0).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn messages_queued_before_a_close_are_written_first() {
    let fx = Fixture::new().await;
    // Repeated, so a close that lands while a queued message is being written is exercised.
    for _ in 0..20 {
        let socket = fx.open_path("/ws").await;
        for i in 0..5 {
            fx.send(&socket, Outgoing::Text(format!("m{i}"))).unwrap();
        }
        close(&fx.sockets, ID, &socket, None, "").unwrap();
        assert_eq!(fx.ended(&socket).await, (NORMAL, String::new(), true));
        let entry = fx.net.log(ID).pop().unwrap();
        assert_eq!(entry.sent, 10);
        assert!(until(|| fx.net.running(ID, Kind::Socket) == 0).await);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_close_and_a_dropped_connection_each_end_with_one_close() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-close").await;
    let expected = (WS_CLOSE_CODE, WS_CLOSE_REASON.to_string(), true);
    assert_eq!(fx.ended(&socket).await, expected);

    let socket = fx.open_path("/ws-drop").await;
    assert_eq!(fx.ended(&socket).await, (ABNORMAL, String::new(), false));
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/closed"));
    assert!(until(|| fx.net.running(ID, Kind::Socket) == 0).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn pings_are_answered() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-ping").await;
    let pong = SocketEventKind::Text {
        data: "pong-ok".into(),
    };
    assert!(until(|| fx.sink.socket_events(&socket).contains(&pong)).await);
}

// ---- Incoming limits ----

#[tokio::test(flavor = "multi_thread")]
async fn a_flood_closes_with_plisto_limit() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-flood").await;
    let limit = (POLICY, PLISTO_LIMIT.to_string(), false);
    assert_eq!(fx.ended(&socket).await, limit);
    let delivered = fx.sink.socket_events(&socket).len() - 1;
    assert!(delivered <= MAX_INCOMING_PER_SECOND as usize, "{delivered}");
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/plisto_limit"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_past_1_mib_closes_with_plisto_limit_unread() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-big").await;
    let limit = (POLICY, PLISTO_LIMIT.to_string(), false);
    assert_eq!(fx.ended(&socket).await, limit);
    assert_eq!(fx.sink.socket_events(&socket).len(), 1);
    assert!(fx.net.log(ID).pop().unwrap().received < MAX_INCOMING as u64);
}

#[test]
fn the_meter_allows_100_messages_and_4_mib_per_second() {
    let start = Instant::now();
    let mut meter = Meter::new(start);
    for _ in 0..MAX_INCOMING_PER_SECOND {
        assert!(meter.admit(1, start));
    }
    assert!(!meter.admit(1, start));
    let next = start + Duration::from_secs(1);
    assert!(meter.admit(MAX_INCOMING_BYTES_PER_SECOND, next));
    assert!(!meter.admit(1, next + Duration::from_millis(999)));
    assert!(meter.admit(1, next + Duration::from_secs(1)));
}

// ---- Window ----

#[tokio::test(flavor = "multi_thread")]
async fn reads_wait_at_the_window_and_resume_on_an_ack() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-heavy").await;
    let message = MAX_INCOMING as u64;
    // Two messages at the incoming limit fill the window.
    assert!(until(|| fx.delivered(&socket) == SOCKET_WINDOW).await);
    fx.rechecked(&socket).await;
    assert_eq!(fx.delivered(&socket), SOCKET_WINDOW);

    ack(&fx.sockets, ID, &socket, message).unwrap();
    assert!(until(|| fx.delivered(&socket) == SOCKET_WINDOW + message).await);
    fx.rechecked(&socket).await;
    assert_eq!(fx.delivered(&socket), SOCKET_WINDOW + message);
    // Sending does not wait on the window.
    fx.send(&socket, Outgoing::Text("still".into())).unwrap();
    close(&fx.sockets, ID, &socket, None, "").unwrap();
    fx.ended(&socket).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ack_out_of_range_or_for_a_socket_not_the_plugins_is_refused() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-heavy").await;
    assert!(until(|| fx.delivered(&socket) == SOCKET_WINDOW).await);
    let over = ack(&fx.sockets, ID, &socket, SOCKET_WINDOW + 1);
    assert_eq!(code(&over), (ApiCode::InvalidArgs, None));
    ack(&fx.sockets, ID, &socket, 10).unwrap();
    ack(&fx.sockets, ID, &socket, 10).unwrap();
    let back = ack(&fx.sockets, ID, &socket, 9);
    assert_eq!(code(&back), (ApiCode::InvalidArgs, None));
    let foreign = ack(&fx.sockets, OTHER, &socket, 10);
    assert_eq!(code(&foreign), (ApiCode::NotFound, None));
    let unknown = ack(&fx.sockets, ID, "s0", 0);
    assert_eq!(code(&unknown), (ApiCode::NotFound, None));
    close(&fx.sockets, ID, &socket, None, "").unwrap();
    fx.ended(&socket).await;
    let closed = ack(&fx.sockets, ID, &socket, 10);
    assert_eq!(code(&closed), (ApiCode::NotFound, None));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_window_left_unacknowledged_closes_as_stalled_and_others_run_on() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-heavy").await;
    let trickle = fx.open_path("/ws-trickle").await;
    let other = fx
        .open_as(OTHER, &fx.net, request(fx.url("/ws")))
        .await
        .unwrap()
        .socket;
    assert!(until(|| fx.delivered(&socket) == SOCKET_WINDOW).await);
    assert!(until(|| fx.delivered(&trickle) > 0).await);

    fx.clock.advance(Duration::from_millis(STALL_MS - 1));
    fx.rechecked(&socket).await;
    assert!(fx.sockets.table().contains_key(&socket));
    fx.clock.advance(Duration::from_millis(1));
    let stalled = (POLICY, PLISTO_STALLED.to_string(), false);
    assert_eq!(fx.ended(&socket).await, stalled);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/plisto_stalled"));
    assert!(until(|| fx.net.running(ID, Kind::Socket) == 1).await);

    // A window that never filled does not stall, though nothing was acknowledged.
    assert!(fx.sockets.table().contains_key(&trickle));
    // Another plugin's socket runs on.
    send(&fx.sockets, OTHER, &other, Outgoing::Text("on".into())).unwrap();
    let echo = SocketEventKind::Text { data: "on".into() };
    assert!(until(|| fx.sink.socket_events(&other).contains(&echo)).await);
    close(&fx.sockets, ID, &trickle, None, "").unwrap();
    close(&fx.sockets, OTHER, &other, None, "").unwrap();
}

// ---- Cancellation ----

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_event_and_forget_close_with_1001() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws").await;
    fx.net.frame_gone(ID);
    let gone = (GOING_AWAY, "frame_gone".to_string(), false);
    assert_eq!(fx.ended(&socket).await, gone);
    assert!(fx.server.saw_ws_close(GOING_AWAY).await);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("aborted/frame_gone"));

    let socket = fx.open_path("/ws").await;
    fx.net.forget(ID);
    let stopped = (GOING_AWAY, "stopped".to_string(), false);
    assert_eq!(fx.ended(&socket).await, stopped);
    let gone = fx.send(&socket, Outgoing::Text("late".into()));
    assert_eq!(code(&gone), (ApiCode::NotFound, None));
    assert!(until(|| fx.net.running(ID, Kind::Socket) == 0).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_frame_event_stops_a_socket_whose_server_keeps_sending() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-trickle").await;
    assert!(until(|| fx.sink.socket_events(&socket).len() >= 3).await);
    fx.net.frame_gone(ID);
    assert_eq!(fx.ended(&socket).await.0, GOING_AWAY);
    assert!(until(|| fx.net.running(ID, Kind::Socket) == 0).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_handshake_that_times_out_or_is_cancelled_drops_its_connection() {
    let fx = Fixture::new().await;
    let slow = SocketRequest {
        timeout: Duration::from_millis(HANDSHAKE_MIN_MS),
        ..request(fx.url("/ws-hang"))
    };
    let got = fx.open(slow).await;
    assert_eq!(code(&got), (ApiCode::Timeout, None));
    assert!(fx.server.saw_close(1).await);

    let heads = fx.server.heads().len();
    let ender = async {
        assert!(until(|| fx.server.heads().len() > heads).await);
        fx.net.frame_gone(ID);
    };
    let (got, ()) = tokio::join!(fx.open(request(fx.url("/ws-hang"))), ender);
    assert_eq!(code(&got), (ApiCode::Aborted, Some("frame_gone")));
    assert!(fx.server.saw_close(2).await);
    assert_eq!(fx.net.running(ID, Kind::Socket), 0);
    assert!(fx.sink.events().is_empty());
    assert_eq!(fx.net.log(ID).len(), 2);
}

// ---- Handshake ----

#[tokio::test(flavor = "multi_thread")]
async fn the_upgrade_offers_protocols_and_returns_the_one_chosen() {
    let fx = Fixture::new().await;
    let offered = SocketRequest {
        protocols: vec!["chat".into(), "v2".into()],
        ..request(fx.url("/ws"))
    };
    let opened = fx.open(offered).await.unwrap();
    assert_eq!(opened.protocol.as_deref(), Some("chat"));
    let head = &fx.server.heads()[0];
    assert_eq!(head.method, "GET");
    assert_eq!(head.header("sec-websocket-protocol"), Some("chat, v2"));
    assert_eq!(head.header("sec-websocket-version"), Some("13"));
    assert_eq!(head.header("upgrade"), Some("websocket"));
    assert_eq!(head.header("user-agent"), Some(USER_AGENT));

    let plain = fx.open(request(fx.url("/ws"))).await.unwrap();
    assert_eq!(plain.protocol, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_or_wrong_upgrade_is_handshake() {
    let fx = Fixture::new().await;
    for path in ["/ws-reject", "/ws-bad-accept", "/ws?choose=evil"] {
        let got = fx.open(request(fx.url(path))).await;
        assert_eq!(code(&got), (ApiCode::Network, Some(HANDSHAKE)), "{path}");
    }
    let log = fx.net.log(ID);
    assert_eq!(log.len(), 3);
    assert_eq!(log[0].status, Some(403));
    assert_eq!(log[0].error.as_deref(), Some("network/handshake"));
    assert_eq!(log[1].status, Some(101));
    assert_eq!(fx.net.running(ID, Kind::Socket), 0);
    assert!(fx.sockets.table().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rebound_name_is_refused_on_the_next_handshake() {
    let fx = Fixture::new().await;
    fx.lookup.answer(A, &[&[LOOPBACK], &[PRIVATE]]);
    let first = fx.open_path("/ws").await;
    let got = fx.open(request(fx.url("/ws"))).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(BLOCKED_ADDRESS)));
    assert_eq!(fx.server.connections(), 1);
    assert_eq!(fx.lookup.calls(), 2);
    close(&fx.sockets, ID, &first, None, "").unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_scheme_an_ip_literal_or_a_refused_header_opens_nothing() {
    let fx = Fixture::new().await;
    let port = fx.server.port;
    let got = fx.open(request(format!("wss://127.0.0.1:{port}/ws"))).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(ORIGIN_NOT_LISTED)));
    let got = fx.open(request(format!("https://{A}:{port}/ws"))).await;
    assert_eq!(code(&got), (ApiCode::InvalidArgs, None));
    let header = SocketRequest {
        headers: vec![("Sec-WebSocket-Key".into(), "x".into())],
        ..request(fx.url("/ws?token=secret"))
    };
    let got = fx.open(header).await;
    assert_eq!(code(&got), (ApiCode::InvalidArgs, Some(FORBIDDEN_HEADER)));
    let protocols = SocketRequest {
        protocols: vec!["a b".into()],
        ..request(fx.url("/ws"))
    };
    let got = fx.open(protocols).await;
    assert_eq!(code(&got), (ApiCode::InvalidArgs, None));
    assert_eq!(fx.server.connections(), 0);
    assert_eq!(fx.lookup.calls(), 0);

    // Only the calls that passed the URL check are logged, by origin only.
    let log = fx.net.log(ID);
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].origin(), format!("wss://{A}:{port}"));
    assert_eq!(
        log[0].error.as_deref(),
        Some("invalid_args/forbidden_header")
    );
    let text = serde_json::to_string(&log).unwrap();
    for leak in ["token", "secret", "/ws"] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_dev_path_needs_developer_mode() {
    let ca = TestCa::new();
    let mut fx = Fixture::with(&ca, TestServer::plain().await);
    let port = fx.server.port;
    fx.origins = vec![format!("http://127.0.0.1:{port}")];
    let url = format!("ws://127.0.0.1:{port}/ws");
    let got = fx.open(request(url.clone())).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(DEV_ONLY)));
    assert_eq!(fx.server.connections(), 0);

    fx.dev_mode = true;
    let socket = fx.open(request(url)).await.unwrap().socket;
    fx.send(&socket, Outgoing::Text("dev".into())).unwrap();
    let echo = SocketEventKind::Text { data: "dev".into() };
    assert!(until(|| fx.sink.socket_events(&socket).contains(&echo)).await);
    assert_eq!(fx.lookup.calls(), 0);
}

// ---- Caps and ownership ----

#[tokio::test(flavor = "multi_thread")]
async fn a_third_socket_is_busy_and_open_sockets_hold_no_in_flight_slot() {
    let fx = Fixture::new().await;
    let api = ApiState::default();
    let first = fx
        .open_with(api.net(), request(fx.url("/ws")))
        .await
        .unwrap();
    fx.open_with(api.net(), request(fx.url("/ws")))
        .await
        .unwrap();
    let third = fx.open_with(api.net(), request(fx.url("/ws"))).await;
    assert_eq!(code(&third), (ApiCode::Busy, None));
    assert_eq!(fx.server.connections(), 2);

    assert_eq!(api.in_flight(ID), 0);
    let calls: Vec<_> = (0..MAX_IN_FLIGHT).map(|_| api.enter(ID).unwrap()).collect();
    assert_eq!(calls.len(), MAX_IN_FLIGHT as usize);

    // A closed socket frees its slot once its connection is gone.
    close(&fx.sockets, ID, &first.socket, None, "").unwrap();
    assert!(until(|| api.net().running(ID, Kind::Socket) == 1).await);
    assert!(fx
        .open_with(api.net(), request(fx.url("/ws")))
        .await
        .is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn another_plugins_or_an_unknown_socket_is_not_found() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws").await;
    let foreign = send(&fx.sockets, OTHER, &socket, Outgoing::Text("x".into()));
    assert_eq!(code(&foreign), (ApiCode::NotFound, None));
    let foreign = close(&fx.sockets, OTHER, &socket, None, "");
    assert_eq!(code(&foreign), (ApiCode::NotFound, None));
    let unknown = fx.send("s0", Outgoing::Text("x".into()));
    assert_eq!(code(&unknown), (ApiCode::NotFound, None));

    // The owner's socket is untouched.
    fx.send(&socket, Outgoing::Text("mine".into())).unwrap();
    let echo = SocketEventKind::Text {
        data: "mine".into(),
    };
    assert!(until(|| fx.sink.socket_events(&socket).contains(&echo)).await);
}

/// A table holding one socket of `ID` whose queue nobody drains.
fn idle_socket() -> (
    Sockets,
    mpsc::Receiver<Message>,
    oneshot::Receiver<CloseFrame>,
) {
    let sockets = Sockets::default();
    let (outbox, queued) = mpsc::channel(SEND_QUEUE);
    let (close, closing) = oneshot::channel();
    let handle = Handle {
        plugin: ID.to_string(),
        outbox,
        close,
        window: Arc::new(Window::new(Instant::now())),
    };
    sockets.table().insert("s-idle".into(), handle);
    (sockets, queued, closing)
}

#[test]
fn a_full_send_queue_is_busy_and_an_oversize_message_is_refused() {
    let (sockets, _queued, _closing) = idle_socket();
    let too_long = send(
        &sockets,
        ID,
        "s-idle",
        Outgoing::Text("x".repeat(MAX_SEND + 1)),
    );
    assert_eq!(code(&too_long), (ApiCode::InvalidArgs, None));
    let too_long = send(
        &sockets,
        ID,
        "s-idle",
        Outgoing::Binary(vec![0; MAX_SEND + 1]),
    );
    assert_eq!(code(&too_long), (ApiCode::InvalidArgs, None));

    send(&sockets, ID, "s-idle", Outgoing::Binary(vec![0; MAX_SEND])).unwrap();
    for _ in 1..SEND_QUEUE {
        send(&sockets, ID, "s-idle", Outgoing::Text("x".into())).unwrap();
    }
    let full = send(&sockets, ID, "s-idle", Outgoing::Text("x".into()));
    assert_eq!(code(&full), (ApiCode::Busy, None));
}

#[test]
fn close_codes_and_reasons_are_limited() {
    for refused in [999, 1001, 1008, 2999, 5000] {
        let (sockets, _queued, _closing) = idle_socket();
        let got = close(&sockets, ID, "s-idle", Some(refused), "");
        assert_eq!(code(&got), (ApiCode::InvalidArgs, None), "{refused}");
        assert_eq!(sockets.len(), 1);
    }
    let (sockets, _queued, _closing) = idle_socket();
    let got = close(
        &sockets,
        ID,
        "s-idle",
        None,
        &"r".repeat(MAX_CLOSE_REASON + 1),
    );
    assert_eq!(code(&got), (ApiCode::InvalidArgs, None));

    for (allowed, reason) in [(None, ""), (Some(3000), "x"), (Some(4999), "")] {
        let (sockets, _queued, mut closing) = idle_socket();
        let longest = "r".repeat(MAX_CLOSE_REASON);
        let reason = if allowed.is_none() {
            longest.as_str()
        } else {
            reason
        };
        close(&sockets, ID, "s-idle", allowed, reason).unwrap();
        let frame = closing.try_recv().unwrap();
        assert_eq!(u16::from(frame.code), allowed.unwrap_or(NORMAL));
        assert_eq!(frame.reason.as_str(), reason);
        let gone = send(&sockets, ID, "s-idle", Outgoing::Text("x".into()));
        assert_eq!(code(&gone), (ApiCode::NotFound, None));
    }
}

#[test]
fn the_handshake_timeout_has_a_default_and_a_range() {
    assert_eq!(
        handshake_timeout(None).unwrap(),
        Duration::from_millis(HANDSHAKE_DEFAULT_MS)
    );
    for ms in [HANDSHAKE_MIN_MS, HANDSHAKE_MAX_MS] {
        assert_eq!(
            handshake_timeout(Some(ms)).unwrap(),
            Duration::from_millis(ms)
        );
    }
    for ms in [0, HANDSHAKE_MIN_MS - 1, HANDSHAKE_MAX_MS + 1] {
        assert_eq!(
            code(&handshake_timeout(Some(ms))),
            (ApiCode::InvalidArgs, None)
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_socket_logs_one_entry_when_it_ends() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws?token=secret").await;
    fx.send(&socket, Outgoing::Text("abc".into())).unwrap();
    let echo = SocketEventKind::Text { data: "abc".into() };
    assert!(until(|| fx.sink.socket_events(&socket).contains(&echo)).await);
    assert!(fx.net.log(ID).is_empty());
    close(&fx.sockets, ID, &socket, None, "").unwrap();
    fx.ended(&socket).await;

    let log = fx.net.log(ID);
    assert_eq!(log.len(), 1);
    let entry = &log[0];
    assert_eq!(entry.kind, LogKind::Socket);
    assert_eq!(entry.method, "GET");
    assert_eq!(entry.origin(), format!("wss://{A}:{}", fx.server.port));
    assert_eq!(entry.status, Some(101));
    assert_eq!(entry.error, None);
    assert_eq!((entry.sent, entry.received), (3, 3));
    let text = serde_json::to_string(&log).unwrap();
    for leak in ["token", "secret", "/ws"] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }
}

// ---- Proxy ----

/// A fixture whose proxy reads `answer`, with a listed origin on a port nothing listens on.
async fn behind_proxy(answer: Answer) -> (Fixture, Arc<ScriptedSource>, String) {
    let ca = TestCa::new();
    let mut fx = Fixture::with(&ca, TestServer::tls(&ca, &[A]).await);
    let source = Arc::new(ScriptedSource::new(answer));
    fx.clients = Clients::for_tests(fx.lookup.clone(), test_allowed, ca.root())
        .with_proxy(Proxy::new(source.clone(), Arc::new(SystemClock)));
    let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    fx.origins.push(format!("https://{A}:{port}"));
    (fx, source, format!("wss://{A}:{port}/ws"))
}

const MANUAL: Answer = Answer {
    user: UserProxy {
        auto_detect: false,
        auto_config: false,
        proxy: true,
    },
    machine: false,
    environment: false,
    found: false,
    delay: Duration::ZERO,
    fails: false,
    discovery_fails: false,
    discovery_panics: false,
};

#[tokio::test(flavor = "multi_thread")]
async fn a_connect_failure_behind_a_proxy_is_proxy_and_its_log_keeps_both() {
    let (fx, _, closed) = behind_proxy(MANUAL).await;
    let got = fx.open(request(closed)).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(PROXY)));
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/connect+proxy"));

    let (fx, _, closed) = behind_proxy(Answer::default()).await;
    let got = fx.open(request(closed)).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(CONNECT)));
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/connect"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guard_refusal_or_a_refused_upgrade_behind_a_proxy_is_never_rewritten() {
    let answer = Answer {
        user: UserProxy {
            auto_detect: true,
            ..MANUAL.user
        },
        found: true,
        ..MANUAL
    };
    let (fx, source, _) = behind_proxy(answer).await;
    let got = fx.open(request(fx.url("/ws-reject"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(HANDSHAKE)));
    fx.lookup.answer(A, &[&[PRIVATE]]);
    let got = fx.open(request(fx.url("/ws"))).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(BLOCKED_ADDRESS)));
    assert_eq!(source.discoveries(), 0);
    let log = fx.net.log(ID);
    assert_eq!(log[0].error.as_deref(), Some("network/handshake"));
    assert_eq!(log[1].error.as_deref(), Some("denied/blocked_address"));
}

// ---- End paths under failure ----

#[tokio::test(flavor = "multi_thread")]
async fn a_close_while_a_write_is_blocked_ends_within_the_grace() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-deaf").await;
    // Fill the server's unread TCP buffers until the queue stops draining.
    let mut stalled = 0;
    let mut accepted = 0;
    while stalled < 25 && accepted < 4096 {
        match fx.send(&socket, Outgoing::Binary(vec![0; MAX_SEND])) {
            Ok(()) => {
                accepted += 1;
                stalled = 0;
            }
            Err(error) => {
                assert_eq!(error.code, ApiCode::Busy);
                stalled += 1;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    assert_eq!(stalled, 25, "the writes never blocked");

    let asked = Instant::now();
    close(&fx.sockets, ID, &socket, None, "").unwrap();
    assert_eq!(fx.ended(&socket).await, (ABNORMAL, String::new(), false));
    assert!(asked.elapsed() < CLOSE_GRACE + Duration::from_secs(2));
    assert!(until(|| fx.net.running(ID, Kind::Socket) == 0).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_panicking_driver_still_ends_its_socket_once() {
    let mut fx = Fixture::new().await;
    fx.sink = Arc::new(RecordingSink::panicking_on_message());
    let socket = fx.open_path("/ws").await;
    fx.send(&socket, Outgoing::Text("boom".into())).unwrap();
    assert_eq!(fx.ended(&socket).await, (ABNORMAL, String::new(), false));
    assert!(fx.sockets.table().is_empty());
    assert!(until(|| fx.net.running(ID, Kind::Socket) == 0).await);
    assert_eq!(fx.net.log(ID).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_answer_is_handshake_and_is_not_followed() {
    let fx = Fixture::new().await;
    let got = fx.open(request(fx.url("/ws-redirect"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(HANDSHAKE)));
    assert_eq!(fx.server.heads().len(), 1);
    assert_eq!(fx.net.log(ID)[0].status, Some(302));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_message_ends_with_one_close_and_logs_protocol() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-bad-utf8").await;
    assert_eq!(fx.ended(&socket).await, (ABNORMAL, String::new(), false));
    assert_eq!(fx.sink.socket_events(&socket).len(), 1);
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/protocol"));
}

#[tokio::test(flavor = "multi_thread")]
async fn fragments_past_1_mib_together_close_with_plisto_limit() {
    let fx = Fixture::new().await;
    let socket = fx.open_path("/ws-fragments").await;
    let limit = (POLICY, PLISTO_LIMIT.to_string(), false);
    assert_eq!(fx.ended(&socket).await, limit);
    assert_eq!(fx.sink.socket_events(&socket).len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn more_than_4_mib_in_a_second_closes_with_plisto_limit() {
    let mut fx = Fixture::new().await;
    fx.acking = true;
    let socket = fx.open_path("/ws-heavy").await;
    let limit = (POLICY, PLISTO_LIMIT.to_string(), false);
    assert_eq!(fx.ended(&socket).await, limit);
    let delivered = fx.sink.socket_events(&socket).len() - 1;
    assert!(delivered < 20, "{delivered}");
    assert!(delivered >= MAX_INCOMING_BYTES_PER_SECOND / MAX_INCOMING);
}
