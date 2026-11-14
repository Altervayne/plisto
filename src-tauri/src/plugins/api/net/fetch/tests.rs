// The engine against a local server on 127.0.0.1. Test names resolve through a scripted lookup, and
// 127.0.0.1 counts as public only under `test_allowed`, so nothing here reaches another host.

// -- Library Imports --
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::{Duration, Instant};

// -- Local Imports --
use super::super::address;
use super::super::proxy::{
    Answer, Proxy, ProxyKind, ScriptedSource, SystemClock, UserProxy, DISCOVERY_WAIT,
};
use super::super::state::Kind;
use super::super::test_server::{pattern, ScriptedLookup, TestCa, TestServer, BIN_LEN};
use super::super::{
    BLOCKED_ADDRESS, DEV_ONLY, DNS, FORBIDDEN_HEADER, MAX_REQUEST_BODY, ORIGIN_NOT_LISTED,
    REDIRECT_NOT_LISTED, REQUEST_BODY, RESPONSE_BODY,
};
use super::*;
use crate::plugins::api::error::ApiCode;

const ID: &str = "com.example.net";
const A: &str = "a.plisto-fixture.com";
const B: &str = "b.plisto-fixture.com";
/// Listed and resolvable, but not named by the server's certificate.
const WRONG: &str = "wrong.plisto-fixture.com";
const LOOPBACK: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const PRIVATE: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
const USER_AGENT: &str = "Plisto/2.7.0 (com.example.net/1.0.0)";

fn test_allowed(ip: IpAddr) -> bool {
    ip == LOOPBACK || address::allowed(ip)
}

type Code = (ApiCode, Option<&'static str>);

struct Fixture {
    server: TestServer,
    lookup: Arc<ScriptedLookup>,
    clients: Clients,
    net: NetState,
    origins: Vec<String>,
    dev_mode: bool,
}

impl Fixture {
    async fn new() -> Fixture {
        let ca = TestCa::new();
        let server = TestServer::tls(&ca, &[A, B]).await;
        Fixture::with(&ca, server)
    }

    fn with(ca: &TestCa, server: TestServer) -> Fixture {
        let lookup = Arc::new(ScriptedLookup::default());
        for name in [A, B, WRONG] {
            lookup.answer(name, &[&[LOOPBACK]]);
        }
        let origins = [A, B, WRONG]
            .map(|name| format!("https://{name}:{}", server.port))
            .to_vec();
        Fixture {
            clients: Clients::for_tests(lookup.clone(), test_allowed, ca.root()),
            server,
            lookup,
            net: NetState::default(),
            origins,
            dev_mode: false,
        }
    }

    fn url(&self, host: &str, path: &str) -> String {
        format!("https://{host}:{}{path}", self.server.port)
    }

    async fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, ApiError> {
        let consent = Consent {
            origins: &self.origins,
            dev_mode: self.dev_mode,
        };
        execute(&self.clients, &self.net, ID, consent, request).await
    }
}

fn get(url: String) -> FetchRequest {
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

fn post(url: String, body: Vec<u8>) -> FetchRequest {
    FetchRequest {
        method: Method::Post,
        body,
        ..get(url)
    }
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect()
}

fn code(result: &Result<FetchResponse, ApiError>) -> Code {
    match result {
        Ok(response) => panic!("expected an error, got status {}", response.status),
        Err(error) => (error.code, error.reason),
    }
}

fn header<'a>(response: &'a FetchResponse, name: &str) -> Option<&'a str> {
    response
        .headers
        .headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

// ---- Requests and responses ----

#[tokio::test(flavor = "multi_thread")]
async fn get_post_and_head_carry_bytes_intact() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/bin"))).await.unwrap();
    assert_eq!(got.status, 200);
    assert_eq!(got.body, pattern(BIN_LEN));
    assert!(!got.redirected);
    assert_eq!(got.url.as_str(), fx.url(A, "/bin"));

    let sent = pattern(300 * 1024);
    let got = fx
        .fetch(post(fx.url(A, "/echo"), sent.clone()))
        .await
        .unwrap();
    assert_eq!(got.body, sent);
    let head = &fx.server.heads()[1];
    assert_eq!(head.method, "POST");
    assert_eq!(head.body, sent);

    let request = FetchRequest {
        method: Method::Head,
        ..get(fx.url(A, "/bin"))
    };
    let got = fx.fetch(request).await.unwrap();
    assert_eq!(got.status, 200);
    assert!(got.body.is_empty());
    assert_eq!(
        header(&got, "content-length"),
        Some(BIN_LEN.to_string().as_str())
    );
    assert_eq!(fx.server.heads()[2].method, "HEAD");
}

#[tokio::test(flavor = "multi_thread")]
async fn error_statuses_are_results() {
    let fx = Fixture::new().await;
    for status in [404, 500] {
        let got = fx
            .fetch(get(fx.url(A, &format!("/status/{status}"))))
            .await
            .unwrap();
        assert_eq!(got.status, status);
        assert_eq!(got.body, b"status");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn response_headers_keep_their_order_and_set_cookie_moves_out() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/set-cookie"))).await.unwrap();
    let names: Vec<&str> = got
        .headers
        .headers
        .iter()
        .map(|(n, _)| n.as_str())
        .filter(|n| n.starts_with("x-"))
        .collect();
    assert_eq!(names, ["x-a", "x-b", "x-c"]);
    assert!(got.headers.headers.iter().all(|(n, _)| n != "set-cookie"));
    assert_eq!(got.headers.set_cookies, ["a=1; Path=/", "b=2"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn plisto_sends_its_user_agent_unless_the_author_sets_one_and_asks_for_identity() {
    let fx = Fixture::new().await;
    fx.fetch(get(fx.url(A, "/echo"))).await.unwrap();
    let own = FetchRequest {
        headers: pairs(&[("User-Agent", "mine/1")]),
        ..get(fx.url(A, "/echo"))
    };
    fx.fetch(own).await.unwrap();
    let heads = fx.server.heads();
    assert_eq!(heads[0].header("user-agent"), Some(USER_AGENT));
    assert_eq!(heads[1].header("user-agent"), Some("mine/1"));
    for head in &heads {
        assert_eq!(head.header("accept-encoding"), Some("identity"));
        for absent in ["cookie", "origin", "referer"] {
            assert_eq!(head.header(absent), None, "{absent}");
        }
    }
}

// ---- Redirects ----

#[tokio::test(flavor = "multi_thread")]
async fn three_hops_are_followed() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/redirect/3"))).await.unwrap();
    assert_eq!(got.status, 200);
    assert!(got.redirected);
    assert_eq!(got.url.as_str(), fx.url(A, "/redirect/0"));
    assert_eq!(got.body, b"done");
    assert_eq!(fx.server.heads().len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sixth_hop_is_refused() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/redirect/6"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(REDIRECT)));
    // The first request and five hops; the sixth hop is never sent.
    assert_eq!(fx.server.heads().len(), 6);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unlisted_hop_is_refused_before_any_connection() {
    let ca = TestCa::new();
    let fx = Fixture::with(&ca, TestServer::tls(&ca, &[A, B]).await);
    let other = TestServer::tls(&ca, &[A]).await;
    let unlisted = format!("https://{A}:{}/echo", other.port);
    let got = fx
        .fetch(get(fx.url(A, &format!("/to/302/{unlisted}"))))
        .await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(REDIRECT_NOT_LISTED)));
    assert_eq!(other.connections(), 0);
    assert_eq!(fx.lookup.calls(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn see_other_turns_post_into_get_and_307_keeps_the_body() {
    let fx = Fixture::new().await;
    let echo = fx.url(A, "/echo");
    let sent = pattern(4096);

    let got = fx
        .fetch(post(fx.url(A, &format!("/to/303/{echo}")), sent.clone()))
        .await
        .unwrap();
    assert!(got.body.is_empty());
    let after = &fx.server.heads()[1];
    assert_eq!(after.method, "GET");
    assert!(after.body.is_empty());

    let got = fx
        .fetch(post(fx.url(A, &format!("/to/307/{echo}")), sent.clone()))
        .await
        .unwrap();
    assert_eq!(got.body, sent);
    assert_eq!(fx.server.heads()[3].method, "POST");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cross_origin_hop_drops_credentials() {
    let fx = Fixture::new().await;
    let request = FetchRequest {
        headers: pairs(&[
            ("Authorization", "Bearer t"),
            ("Cookie", "s=1"),
            ("X-Keep", "1"),
        ]),
        ..get(fx.url(A, &format!("/to/307/{}", fx.url(B, "/echo"))))
    };
    let got = fx.fetch(request).await.unwrap();
    assert_eq!(got.url.as_str(), fx.url(B, "/echo"));
    let heads = fx.server.heads();
    assert_eq!(heads[0].header("authorization"), Some("Bearer t"));
    assert_eq!(heads[0].header("cookie"), Some("s=1"));
    assert_eq!(heads[1].header("authorization"), None);
    assert_eq!(heads[1].header("cookie"), None);
    assert_eq!(heads[1].header("x-keep"), Some("1"));
}

#[tokio::test(flavor = "multi_thread")]
async fn manual_returns_the_redirect_and_error_refuses_it() {
    let fx = Fixture::new().await;
    let manual = FetchRequest {
        redirect: RedirectMode::Manual,
        ..get(fx.url(A, "/redirect/1"))
    };
    let got = fx.fetch(manual).await.unwrap();
    assert_eq!(got.status, 302);
    assert!(!got.redirected);
    assert_eq!(header(&got, "location"), Some("/redirect/0"));

    let error = FetchRequest {
        redirect: RedirectMode::Error,
        ..get(fx.url(A, "/redirect/1"))
    };
    let got = fx.fetch(error).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(REDIRECT)));
    assert_eq!(fx.server.heads().len(), 2);
}

// ---- Address guard and pinning ----

#[tokio::test(flavor = "multi_thread")]
async fn a_rebound_name_is_refused_on_its_next_connection() {
    let fx = Fixture::new().await;
    fx.lookup.answer(A, &[&[LOOPBACK], &[PRIVATE]]);
    assert!(fx.fetch(get(fx.url(A, "/echo"))).await.is_ok());
    let got = fx.fetch(get(fx.url(A, "/echo"))).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(BLOCKED_ADDRESS)));
    assert!(!got.unwrap_err().message.contains("10.0.0.1"));
    assert_eq!(fx.server.connections(), 1);
    assert_eq!(fx.lookup.calls(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mixed_answer_opens_no_connection() {
    let fx = Fixture::new().await;
    fx.lookup.answer(A, &[&[LOOPBACK, PRIVATE]]);
    let got = fx.fetch(get(fx.url(A, "/echo"))).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(BLOCKED_ADDRESS)));
    assert_eq!(fx.server.connections(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ip_literal_or_credentials_in_the_url_are_refused_before_the_client() {
    let fx = Fixture::new().await;
    let literal = format!("https://127.0.0.1:{}/echo", fx.server.port);
    let got = fx.fetch(get(literal)).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(ORIGIN_NOT_LISTED)));
    let credentials = format!("https://user:pw@{A}:{}/echo", fx.server.port);
    let got = fx.fetch(get(credentials)).await;
    assert_eq!(code(&got), (ApiCode::InvalidArgs, None));
    assert_eq!(fx.server.connections(), 0);
    assert_eq!(fx.lookup.calls(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_that_does_not_resolve_is_dns() {
    let fx = Fixture::new().await;
    fx.lookup.answer(A, &[&[]]);
    let got = fx.fetch(get(fx.url(A, "/echo"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(DNS)));
    assert_eq!(fx.server.connections(), 0);
}

// ---- Caps, deadline and cancellation ----

#[tokio::test(flavor = "multi_thread")]
async fn a_declared_length_past_the_cap_is_refused_before_the_body() {
    let fx = Fixture::new().await;
    // The server declares 9 MiB and sends nothing, so reading would wait out its 10 s hold.
    let started = Instant::now();
    let got = fx.fetch(get(fx.url(A, "/big"))).await;
    assert_eq!(code(&got), (ApiCode::TooLarge, Some(RESPONSE_BODY)));
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_chunked_body_is_cut_at_the_cap_and_its_connection_closed() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/big?chunked"))).await;
    assert_eq!(code(&got), (ApiCode::TooLarge, Some(RESPONSE_BODY)));
    assert!(fx.server.saw_close(1).await);
    let entry = fx.net.log(ID).pop().unwrap();
    assert!(entry.received > MAX_RESPONSE_BODY as u64);
    assert!(entry.received < 2 * MAX_RESPONSE_BODY as u64);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_body_past_the_cap_is_refused_before_any_connection() {
    let fx = Fixture::new().await;
    let got = fx
        .fetch(post(fx.url(A, "/echo"), vec![0; MAX_REQUEST_BODY + 1]))
        .await;
    assert_eq!(code(&got), (ApiCode::TooLarge, Some(REQUEST_BODY)));
    assert_eq!(fx.server.connections(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_deadline_ends_the_call_and_closes_the_connection() {
    let fx = Fixture::new().await;
    let request = FetchRequest {
        timeout: Duration::from_millis(500),
        ..get(fx.url(A, "/slow"))
    };
    let started = Instant::now();
    let got = fx.fetch(request).await;
    assert_eq!(code(&got), (ApiCode::Timeout, None));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(fx.server.saw_close(1).await);
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);
}

/// Starts a `/slow` fetch with `key`, waits until its body is flowing, ends it with `end`, and
/// returns how the fetch resolved.
async fn end_mid_body(fx: &Fixture, key: &str, end: impl FnOnce(&NetState)) -> Code {
    let request = FetchRequest {
        abort_key: Some(key.to_string()),
        ..get(fx.url(A, "/slow"))
    };
    let heads = fx.server.heads().len();
    let ender = async {
        while fx.server.heads().len() == heads {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(fx.net.running(ID, Kind::Fetch), 1);
        end(&fx.net);
    };
    let (got, ()) = tokio::join!(fx.fetch(request), ender);
    code(&got)
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_mid_body_aborts_and_closes_the_connection() {
    let fx = Fixture::new().await;
    let got = end_mid_body(&fx, "k", |net| assert_eq!(net.abort(ID, "k"), 1)).await;
    assert_eq!(got, (ApiCode::Aborted, Some("abort")));
    assert!(fx.server.saw_close(1).await);
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);

    let got = end_mid_body(&fx, "k2", |net| net.frame_gone(ID)).await;
    assert_eq!(got, (ApiCode::Aborted, Some("frame_gone")));
    assert!(fx.server.saw_close(2).await);

    let got = end_mid_body(&fx, "k3", |net| net.forget(ID)).await;
    assert_eq!(got, (ApiCode::Aborted, Some("stopped")));
    assert!(fx.server.saw_close(3).await);
}

// ---- TLS ----

#[tokio::test(flavor = "multi_thread")]
async fn a_certificate_from_a_foreign_ca_is_refused() {
    let trusted = TestCa::new();
    let foreign = TestCa::new();
    let fx = Fixture::with(&trusted, TestServer::tls(&foreign, &[A]).await);
    let got = fx.fetch(get(fx.url(A, "/echo"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(TLS)));
    assert!(fx.server.heads().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_certificate_for_another_name_is_refused() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(WRONG, "/echo"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(TLS)));
    assert!(fx.server.heads().is_empty());
}

// ---- Developer path and cookies ----

async fn dev_fixture() -> Fixture {
    let ca = TestCa::new();
    let mut fx = Fixture::with(&ca, TestServer::plain().await);
    let port = fx.server.port;
    fx.origins = vec![
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ];
    fx
}

#[tokio::test(flavor = "multi_thread")]
async fn the_dev_path_needs_developer_mode() {
    let mut fx = dev_fixture().await;
    let port = fx.server.port;
    let ip = format!("http://127.0.0.1:{port}/echo");
    let name = format!("http://localhost:{port}/echo");
    for url in [&ip, &name] {
        let got = fx.fetch(get(url.clone())).await;
        assert_eq!(code(&got), (ApiCode::Denied, Some(DEV_ONLY)));
    }
    assert_eq!(fx.server.connections(), 0);

    fx.dev_mode = true;
    for url in [&ip, &name] {
        let got = fx.fetch(get(url.clone())).await.unwrap();
        assert_eq!(got.status, 200);
    }
    assert_eq!(fx.server.connections(), 2);
    // The dev path never consults the public resolver.
    assert_eq!(fx.lookup.calls(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_https_dev_url_is_refused() {
    let mut fx = dev_fixture().await;
    fx.dev_mode = true;
    let port = fx.server.port;
    for url in [
        format!("https://127.0.0.1:{port}/echo"),
        format!("https://localhost:{port}/echo"),
    ] {
        let got = fx.fetch(get(url)).await;
        assert_eq!(code(&got), (ApiCode::Denied, Some(ORIGIN_NOT_LISTED)));
    }
    assert_eq!(fx.server.connections(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_cookie_is_kept_between_requests() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/set-cookie"))).await.unwrap();
    assert_eq!(got.headers.set_cookies.len(), 2);
    fx.fetch(get(fx.url(A, "/echo"))).await.unwrap();
    assert_eq!(fx.server.heads()[1].header("cookie"), None);
}

// ---- Transport failures ----

#[tokio::test(flavor = "multi_thread")]
async fn a_close_before_any_response_is_closed() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/close"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(CLOSED)));
    assert_eq!(fx.server.heads().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_chunking_is_protocol() {
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/bad-chunk"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(PROTOCOL)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_body_cut_short_of_its_length_is_closed() {
    // The bytes that came were well formed; the connection ended before the declared length.
    let fx = Fixture::new().await;
    let got = fx.fetch(get(fx.url(A, "/short"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(CLOSED)));
}

// ---- Proxy ----

/// A fixture whose proxy reads `answer`, with a listed origin on a port nothing listens on.
async fn behind_proxy(answer: Answer) -> (Fixture, Arc<ScriptedSource>, String) {
    let ca = TestCa::new();
    let mut fx = Fixture::with(&ca, TestServer::tls(&ca, &[A, B]).await);
    let source = Arc::new(ScriptedSource::new(answer));
    fx.clients = Clients::for_tests(fx.lookup.clone(), test_allowed, ca.root())
        .with_proxy(Proxy::new(source.clone(), Arc::new(SystemClock)));
    let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let origin = format!("https://{A}:{port}");
    fx.origins.push(origin.clone());
    (fx, source, format!("{origin}/echo"))
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

/// Auto-detect on, and a discovery that finds a proxy after `delay`.
fn detecting(delay: Duration) -> Answer {
    Answer {
        user: UserProxy {
            auto_detect: true,
            ..UserProxy::default()
        },
        found: true,
        delay,
        ..Answer::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_discovery_never_turns_a_failure_into_timeout() {
    let (fx, _, _) = behind_proxy(detecting(DISCOVERY_WAIT + Duration::from_secs(1))).await;
    fx.lookup.answer(A, &[&[]]);
    let request = FetchRequest {
        timeout: Duration::from_millis(300),
        ..get(fx.url(A, "/echo"))
    };
    let started = Instant::now();
    let got = fx.fetch(request).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(DNS)));
    assert!(started.elapsed() < DISCOVERY_WAIT + Duration::from_millis(800));
    assert_eq!(fx.net.running(ID, Kind::Fetch), 0);

    let recorded = Instant::now();
    while fx.clients.proxy().kind() != ProxyKind::Detected {
        assert!(recorded.elapsed() < Duration::from_secs(10), "never recorded");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let got = fx.fetch(get(fx.url(A, "/echo"))).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(PROXY)));
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/dns+proxy"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_during_the_discovery_wait_aborts() {
    let (fx, _, _) = behind_proxy(detecting(DISCOVERY_WAIT + Duration::from_secs(1))).await;
    fx.lookup.answer(A, &[&[]]);
    let request = get(fx.url(A, "/echo"));
    let ender = async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        fx.net.frame_gone(ID);
    };
    let started = Instant::now();
    let (got, ()) = tokio::join!(fx.fetch(request), ender);
    assert_eq!(code(&got), (ApiCode::Aborted, Some("frame_gone")));
    assert!(started.elapsed() < DISCOVERY_WAIT);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connect_failure_behind_a_proxy_is_proxy_and_its_log_keeps_both() {
    let (fx, _, closed) = behind_proxy(MANUAL).await;
    let got = fx.fetch(get(closed)).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(PROXY)));
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/connect+proxy"));

    let (fx, _, closed) = behind_proxy(Answer::default()).await;
    let got = fx.fetch(get(closed)).await;
    assert_eq!(code(&got), (ApiCode::Network, Some(CONNECT)));
    let entry = fx.net.log(ID).pop().unwrap();
    assert_eq!(entry.error.as_deref(), Some("network/connect"));
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_detect_runs_one_discovery_after_a_failure() {
    let detecting = Answer {
        user: UserProxy {
            auto_detect: true,
            ..UserProxy::default()
        },
        found: true,
        ..Answer::default()
    };
    let (fx, source, closed) = behind_proxy(detecting).await;
    let got = fx.fetch(get(fx.url(A, "/echo"))).await;
    assert!(got.is_ok());
    assert_eq!(source.discoveries(), 0);
    for _ in 0..2 {
        let got = fx.fetch(get(closed.clone())).await;
        assert_eq!(code(&got), (ApiCode::Network, Some(PROXY)));
    }
    assert_eq!(source.discoveries(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guard_refusal_behind_a_proxy_is_never_rewritten() {
    let answer = Answer {
        user: UserProxy {
            auto_detect: true,
            ..MANUAL.user
        },
        found: true,
        ..MANUAL
    };
    let (fx, source, _) = behind_proxy(answer).await;
    fx.lookup.answer(B, &[&[PRIVATE]]);
    let got = fx.fetch(get(fx.url(B, "/echo"))).await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(BLOCKED_ADDRESS)));
    let got = fx
        .fetch(get("https://unlisted.plisto-fixture.com/x".into()))
        .await;
    assert_eq!(code(&got), (ApiCode::Denied, Some(ORIGIN_NOT_LISTED)));
    assert_eq!(source.discoveries(), 0);
    assert_eq!(
        fx.net.log(ID).pop().unwrap().error.as_deref(),
        Some("denied/blocked_address")
    );
}

// ---- Log ----

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_header_or_body_on_a_listed_url_logs_one_entry_each() {
    let fx = Fixture::new().await;
    let header = FetchRequest {
        headers: pairs(&[("Host", "evil.test")]),
        ..get(fx.url(A, "/echo?token=secret"))
    };
    let got = fx.fetch(header).await;
    assert_eq!(code(&got), (ApiCode::InvalidArgs, Some(FORBIDDEN_HEADER)));
    let body = post(
        fx.url(A, "/echo?token=secret"),
        vec![0; MAX_REQUEST_BODY + 1],
    );
    let got = fx.fetch(body).await;
    assert_eq!(code(&got), (ApiCode::TooLarge, Some(REQUEST_BODY)));
    assert_eq!(fx.server.connections(), 0);

    let log = fx.net.log(ID);
    assert_eq!(log.len(), 2);
    let origin = format!("https://{A}:{}", fx.server.port);
    assert_eq!(log[0].origin(), origin);
    assert_eq!(
        log[0].error.as_deref(),
        Some("invalid_args/forbidden_header")
    );
    assert_eq!(log[1].origin(), origin);
    assert_eq!(log[1].error.as_deref(), Some("too_large/request_body"));
    assert_eq!((log[1].sent, log[1].status), (0, None));
    let text = serde_json::to_string(&log).unwrap();
    for leak in ["echo", "token", "secret", "evil"] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn each_call_past_the_url_check_logs_one_entry_with_its_origin_only() {
    let fx = Fixture::new().await;
    fx.fetch(post(fx.url(A, "/echo?token=secret"), b"abc".to_vec()))
        .await
        .unwrap();
    fx.fetch(get("https://unlisted.plisto-fixture.com/x".into()))
        .await
        .unwrap_err();
    fx.lookup.answer(B, &[&[PRIVATE]]);
    fx.fetch(get(fx.url(B, "/echo"))).await.unwrap_err();

    let log = fx.net.log(ID);
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].origin(), format!("https://{A}:{}", fx.server.port));
    assert_eq!(log[0].method, "POST");
    assert_eq!(log[0].status, Some(200));
    assert_eq!(log[0].error, None);
    assert_eq!((log[0].sent, log[0].received), (3, 3));
    assert_eq!(log[1].error.as_deref(), Some("denied/blocked_address"));
    assert_eq!(log[1].status, None);
    let text = serde_json::to_string(&log).unwrap();
    for leak in ["echo", "token", "secret", "10.0.0.1"] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }
}
