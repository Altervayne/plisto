// The network policy: which URLs, headers and redirects pass, and the refusal each failure gets.

// -- Local Imports --
use super::super::{NetCode, FORBIDDEN_HEADER, REQUEST_BODY};
use super::*;

type Code = (NetCode, Option<&'static str>);

fn origins() -> Vec<String> {
    [
        "https://example.com",
        "https://api.example.com:8443",
        "https://port.example.com:443",
        "https://xn--bcher-kva.de",
        "http://127.0.0.1:8080",
        "http://localhost:9000",
        // Fails the manifest grammar, so it matches nothing.
        "https://*.wild.com",
    ]
    .map(String::from)
    .to_vec()
}

fn consent(origins: &[String], dev_mode: bool) -> Consent<'_> {
    Consent { origins, dev_mode }
}

fn outcome(result: Result<Target, Refusal>) -> Result<String, Code> {
    result
        .map(|target| target.origin)
        .map_err(|r| (r.code, r.reason))
}

const NOT_LISTED: Code = (NetCode::Denied, Some(ORIGIN_NOT_LISTED));
const INVALID: Code = (NetCode::InvalidArgs, None);

fn ok(origin: &str) -> Result<String, Code> {
    Ok(origin.to_string())
}

#[test]
fn urls_match_only_their_exact_origin() {
    let list = origins();
    let cases: Vec<(&str, Transport, bool, Result<String, Code>)> = vec![
        (
            "https://example.com/a?b=1",
            Transport::Fetch,
            false,
            ok("https://example.com"),
        ),
        (
            "HTTPS://EXAMPLE.COM/a",
            Transport::Fetch,
            false,
            ok("https://example.com"),
        ),
        (
            "https://example.com:443/",
            Transport::Fetch,
            false,
            ok("https://example.com"),
        ),
        (
            "https://port.example.com/",
            Transport::Fetch,
            false,
            ok("https://port.example.com:443"),
        ),
        (
            "https://B\u{00DC}CHER.de/x",
            Transport::Fetch,
            false,
            ok("https://xn--bcher-kva.de"),
        ),
        (
            "https://xn--BCHER-kva.de/",
            Transport::Fetch,
            false,
            ok("https://xn--bcher-kva.de"),
        ),
        (
            "https://api.example.com:8443/v1",
            Transport::Fetch,
            false,
            ok("https://api.example.com:8443"),
        ),
        (
            "https://example.com./",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://api.example.com/v1",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://example.com:8443/",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://www.example.com/",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://example.com.evil.test/",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://evilexample.com/",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://a.wild.com/",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://93.184.215.14/",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://[2606:4700::1111]/",
            Transport::Fetch,
            false,
            Err(NOT_LISTED),
        ),
        ("https://0x5d.1/", Transport::Fetch, false, Err(NOT_LISTED)),
        (
            "https://user@example.com/",
            Transport::Fetch,
            false,
            Err(INVALID),
        ),
        (
            "https://user:pw@example.com/",
            Transport::Fetch,
            false,
            Err(INVALID),
        ),
        (
            "https://:pw@example.com/",
            Transport::Fetch,
            false,
            Err(INVALID),
        ),
        (
            "http://example.com/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
        ("ftp://example.com/", Transport::Fetch, false, Err(INVALID)),
        ("wss://example.com/", Transport::Fetch, false, Err(INVALID)),
        ("/relative", Transport::Fetch, false, Err(INVALID)),
        ("not a url", Transport::Fetch, false, Err(INVALID)),
        // Sockets: wss maps to an https origin, ws to a dev origin.
        (
            "wss://example.com/socket",
            Transport::Socket,
            false,
            ok("https://example.com"),
        ),
        (
            "wss://api.example.com:8443/",
            Transport::Socket,
            false,
            ok("https://api.example.com:8443"),
        ),
        (
            "wss://www.example.com/",
            Transport::Socket,
            false,
            Err(NOT_LISTED),
        ),
        (
            "https://example.com/",
            Transport::Socket,
            false,
            Err(INVALID),
        ),
        (
            "ws://example.com/",
            Transport::Socket,
            true,
            Err(NOT_LISTED),
        ),
        (
            "ws://127.0.0.1:8080/s",
            Transport::Socket,
            true,
            ok("http://127.0.0.1:8080"),
        ),
        (
            "ws://127.0.0.1:8080/s",
            Transport::Socket,
            false,
            Err((NetCode::Denied, Some(DEV_ONLY))),
        ),
        // Dev origins: honored only with developer mode, on the exact host and port.
        (
            "http://127.0.0.1:8080/echo",
            Transport::Fetch,
            true,
            ok("http://127.0.0.1:8080"),
        ),
        (
            "http://127.0.0.1:8080/echo",
            Transport::Fetch,
            false,
            Err((NetCode::Denied, Some(DEV_ONLY))),
        ),
        (
            "http://localhost:9000/",
            Transport::Fetch,
            true,
            ok("http://localhost:9000"),
        ),
        (
            "http://LOCALHOST:9000/",
            Transport::Fetch,
            true,
            ok("http://localhost:9000"),
        ),
        (
            "http://localhost:8080/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
        (
            "http://127.0.0.1:9000/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
        (
            "http://127.0.0.1:8081/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
        ("http://127.0.0.1/", Transport::Fetch, true, Err(NOT_LISTED)),
        (
            "http://[::1]:8080/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
        (
            "http://localhost.:9000/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
        (
            "https://127.0.0.1:8080/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
        (
            "https://localhost:9000/",
            Transport::Fetch,
            true,
            Err(NOT_LISTED),
        ),
    ];
    for (raw, transport, dev_mode, expected) in cases {
        let got = outcome(check_url(raw, transport, consent(&list, dev_mode)));
        assert_eq!(got, expected, "{raw}");
    }
}

#[test]
fn a_matched_url_is_normalized_and_drops_its_fragment() {
    let list = origins();
    let target = check_url(
        "https://Example.com:443/a?b=1#frag",
        Transport::Fetch,
        consent(&list, false),
    )
    .unwrap();
    assert_eq!(target.url.as_str(), "https://example.com/a?b=1");
    assert_eq!(target.kind, OriginKind::Public);
    let dev = check_url(
        "http://127.0.0.1:8080/x#y",
        Transport::Fetch,
        consent(&list, true),
    )
    .unwrap();
    assert_eq!(dev.url.as_str(), "http://127.0.0.1:8080/x");
    assert_eq!(dev.kind, OriginKind::DevLoopback);
}

#[test]
fn a_url_past_the_length_limit_is_refused() {
    let list = origins();
    let base = "https://example.com/";
    let at = format!("{base}{}", "a".repeat(MAX_URL_BYTES - base.len()));
    assert!(check_url(&at, Transport::Fetch, consent(&list, false)).is_ok());
    let past = format!("{at}a");
    let got = outcome(check_url(&past, Transport::Fetch, consent(&list, false)));
    assert_eq!(got, Err(INVALID));
    // Under the limit as typed, past it once the path is percent-encoded.
    let grows = format!("{base}{}", "\u{e9}".repeat(MAX_URL_BYTES / 4));
    assert!(grows.len() <= MAX_URL_BYTES);
    let got = outcome(check_url(&grows, Transport::Fetch, consent(&list, false)));
    assert_eq!(got, Err(INVALID));
}

#[test]
fn no_origin_is_listed_with_an_empty_consent() {
    let got = outcome(check_url(
        "https://example.com/",
        Transport::Fetch,
        consent(&[], true),
    ));
    assert_eq!(got, Err(NOT_LISTED));
}

#[test]
fn a_refusal_never_carries_the_url() {
    let list = origins();
    for raw in [
        "https://evil.test/secret?token=abc",
        "https://user:pw@example.com/secret",
    ] {
        let refused = check_url(raw, Transport::Fetch, consent(&list, false)).unwrap_err();
        assert!(!refused.message.contains("secret"));
        assert!(!refused.message.contains("evil"));
    }
}

#[test]
fn socket_urls_upgrade_over_http_schemes() {
    let cases = [
        ("wss://example.com/s?x=1", Some("https://example.com/s?x=1")),
        (
            "wss://api.example.com:8443/",
            Some("https://api.example.com:8443/"),
        ),
        ("wss://example.com:443/", Some("https://example.com/")),
        ("ws://127.0.0.1:8080/s", Some("http://127.0.0.1:8080/s")),
        ("https://example.com/", None),
    ];
    for (raw, expected) in cases {
        let url = Url::parse(raw).unwrap();
        assert_eq!(
            upgrade_url(&url).as_ref().map(Url::as_str),
            expected,
            "{raw}"
        );
    }
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter()
        .map(|(n, v)| (n.to_string(), v.to_string()))
        .collect()
}

#[test]
fn every_forbidden_header_is_refused_in_any_case() {
    let names = [
        "Accept-Encoding",
        "CONNECTION",
        "Content-Length",
        "eXpect",
        "Host",
        "Keep-Alive",
        "TE",
        "Trailer",
        "Transfer-Encoding",
        "UPGRADE",
        "Proxy-Authorization",
        "PROXY-Connection",
        "proxy-anything",
        "Sec-WebSocket-Key",
        "sec-websocket-protocol",
        "SEC-WEBSOCKET-EXTENSIONS",
    ];
    for name in names {
        let refused = check_headers(&pairs(&[("x-ok", "1"), (name, "v")])).unwrap_err();
        assert_eq!(refused.code, NetCode::InvalidArgs, "{name}");
        assert_eq!(refused.reason, Some(FORBIDDEN_HEADER), "{name}");
    }
}

#[test]
fn author_headers_pass_with_lowercase_names_in_order() {
    let input = pairs(&[
        ("Authorization", "Bearer t"),
        ("Cookie", "a=1"),
        ("User-Agent", "probe/1"),
        ("Origin", "https://example.com"),
        ("Referer", "https://example.com/"),
        ("Content-Type", "application/json"),
        ("Last-Event-ID", "3"),
        ("Proxyish", "1"),
        ("X-Sec-WebSocket-Key", "1"),
        ("X-Empty", ""),
        ("X-Tab", "a\tb"),
    ]);
    let checked = check_headers(&input).unwrap();
    let names: Vec<&str> = checked.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        [
            "authorization",
            "cookie",
            "user-agent",
            "origin",
            "referer",
            "content-type",
            "last-event-id",
            "proxyish",
            "x-sec-websocket-key",
            "x-empty",
            "x-tab"
        ]
    );
    assert_eq!(checked[0].1, "Bearer t");
}

#[test]
fn header_shapes_are_refused_when_malformed() {
    let bad: [(&str, &str); 9] = [
        ("", "v"),
        ("bad name", "v"),
        ("x:y", "v"),
        ("x\u{00e9}", "v"),
        ("x-a", "line\r\nx-b: 1"),
        ("x-a", "nul\0"),
        ("x-a", "del\u{7f}"),
        ("x-a", "caf\u{00e9}"),
        ("x-a", "\n"),
    ];
    for (name, value) in bad {
        let refused = check_headers(&pairs(&[(name, value)])).unwrap_err();
        assert_eq!(
            (refused.code, refused.reason),
            INVALID,
            "{name:?}: {value:?}"
        );
    }
    let repeated = check_headers(&pairs(&[("X-A", "1"), ("x-a", "2")])).unwrap_err();
    assert_eq!((repeated.code, repeated.reason), INVALID);
}

#[test]
fn header_limits_hold_at_and_one_past_each_bound() {
    let count = |n: usize| -> Vec<(String, String)> {
        (0..n)
            .map(|i| (format!("x-{i}"), "v".to_string()))
            .collect()
    };
    assert!(check_headers(&count(MAX_HEADERS)).is_ok());
    assert!(check_headers(&count(MAX_HEADERS + 1)).is_err());

    let name = |len: usize| vec![("x".repeat(len), "v".to_string())];
    assert!(check_headers(&name(MAX_HEADER_NAME)).is_ok());
    assert!(check_headers(&name(MAX_HEADER_NAME + 1)).is_err());

    let value = |len: usize| vec![("x-a".to_string(), "v".repeat(len))];
    assert!(check_headers(&value(MAX_HEADER_VALUE)).is_ok());
    assert!(check_headers(&value(MAX_HEADER_VALUE + 1)).is_err());

    // Four headers of 3 + 4093 bytes fill the total exactly.
    let total = |last: usize| -> Vec<(String, String)> {
        ["x-a", "x-b", "x-c", "x-d"]
            .iter()
            .enumerate()
            .map(|(i, n)| (n.to_string(), "v".repeat(if i == 3 { last } else { 4093 })))
            .collect()
    };
    assert!(check_headers(&total(4093)).is_ok());
    let refused = check_headers(&total(4094)).unwrap_err();
    assert_eq!((refused.code, refused.reason), INVALID);
}

#[test]
fn plisto_sets_user_agent_and_identity_encoding() {
    let ua = user_agent("2.7.0", "dev.example.plugin", "1.0.0");
    assert_eq!(ua, "Plisto/2.7.0 (dev.example.plugin/1.0.0)");
    let sent = outgoing_headers(pairs(&[("x-a", "1")]), &ua);
    assert_eq!(
        sent,
        pairs(&[
            ("x-a", "1"),
            ("user-agent", "Plisto/2.7.0 (dev.example.plugin/1.0.0)"),
            ("accept-encoding", "identity")
        ])
    );
    let own = check_headers(&pairs(&[("User-Agent", "mine/1")])).unwrap();
    let sent = outgoing_headers(own, &ua);
    assert_eq!(
        sent,
        pairs(&[("user-agent", "mine/1"), ("accept-encoding", "identity")])
    );
}

#[test]
fn the_host_header_shows_only_a_non_default_port() {
    let cases = [
        ("https://example.com/a", "example.com"),
        ("https://example.com:443/a", "example.com"),
        ("https://api.example.com:8443/a", "api.example.com:8443"),
        ("http://127.0.0.1:8080/", "127.0.0.1:8080"),
    ];
    for (raw, expected) in cases {
        let url = Url::parse(raw).unwrap();
        assert_eq!(host_header(&url).as_deref(), Some(expected), "{raw}");
    }
}

#[test]
fn set_cookie_moves_out_of_the_response_headers() {
    let raw: [(&str, &[u8]); 4] = [
        ("Content-Type", b"text/plain"),
        ("Set-Cookie", b"a=1; Path=/"),
        ("X-Name", b"caf\xe9"),
        ("set-cookie", b"b=2"),
    ];
    let split = response_headers(raw);
    assert_eq!(
        split.headers,
        pairs(&[("content-type", "text/plain"), ("x-name", "caf\u{00e9}")])
    );
    assert_eq!(split.set_cookies, ["a=1; Path=/", "b=2"]);
}

#[test]
fn a_repeated_response_header_is_grouped_at_its_first_position() {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    let mut map = HeaderMap::new();
    for (name, value) in [("a", "1"), ("b", "2"), ("a", "3")] {
        map.append(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    let split = response_headers(map.iter().map(|(n, v)| (n.as_str(), v.as_bytes())));
    assert_eq!(split.headers, pairs(&[("a", "1"), ("a", "3"), ("b", "2")]));
}

#[test]
fn methods_parse_in_exact_case_only() {
    for name in ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] {
        assert_eq!(Method::parse(name).map(Method::as_str), Some(name));
    }
    for name in ["get", "Post", "OPTIONS", "CONNECT", "TRACE", ""] {
        assert_eq!(Method::parse(name), None, "{name}");
    }
}

#[test]
fn bodies_follow_the_method_and_the_cap() {
    let cases = [
        (Method::Get, 0, Ok(())),
        (Method::Head, 0, Ok(())),
        (Method::Get, 1, Err(INVALID)),
        (Method::Head, 1, Err(INVALID)),
        (Method::Post, MAX_REQUEST_BODY, Ok(())),
        (Method::Put, 1, Ok(())),
        (Method::Patch, 1, Ok(())),
        (Method::Delete, 1, Ok(())),
        (
            Method::Post,
            MAX_REQUEST_BODY + 1,
            Err((NetCode::TooLarge, Some(REQUEST_BODY))),
        ),
    ];
    for (method, len, expected) in cases {
        let got = check_body(method, len).map_err(|r| (r.code, r.reason));
        assert_eq!(got, expected, "{method:?} {len}");
    }
}

fn hop(
    status: u16,
    location: Option<&str>,
    from: &str,
    method: Method,
    headers: &[(String, String)],
    hops: usize,
    dev_mode: bool,
) -> Result<Option<Hop>, Code> {
    let list = origins();
    let url = Url::parse(from).unwrap();
    let sent = Sent {
        url: &url,
        method,
        headers,
        hops,
    };
    next_hop(
        status,
        location.map(str::as_bytes),
        sent,
        consent(&list, dev_mode),
    )
    .map_err(|r| (r.code, r.reason))
}

const FROM: &str = "https://example.com/a/b";
const REDIRECT_REFUSED: Code = (NetCode::Denied, Some(REDIRECT_NOT_LISTED));
const TOO_MANY: Code = (NetCode::Network, Some(REDIRECT));

#[test]
fn each_redirect_status_sets_method_and_body() {
    use Method::*;
    let cases = [
        (301, Post, Get, false),
        (301, Put, Put, true),
        (301, Delete, Delete, true),
        (301, Get, Get, true),
        (301, Head, Head, true),
        (302, Post, Get, false),
        (302, Put, Put, true),
        (302, Delete, Delete, true),
        (302, Get, Get, true),
        (303, Post, Get, false),
        (303, Patch, Get, false),
        (303, Head, Head, false),
        (307, Post, Post, true),
        (307, Patch, Patch, true),
        (308, Put, Put, true),
        (308, Delete, Delete, true),
    ];
    for (status, from, to, keep_body) in cases {
        let next = hop(status, Some("/next"), FROM, from, &[], 0, false)
            .unwrap()
            .unwrap();
        assert_eq!(
            (next.method, next.keep_body),
            (to, keep_body),
            "{status} {from:?}"
        );
        assert_eq!(next.target.url.as_str(), "https://example.com/next");
    }
}

#[test]
fn a_status_that_is_not_a_redirect_is_delivered() {
    for status in [200, 204, 300, 304, 305, 306, 404, 500] {
        assert_eq!(
            hop(status, Some("/next"), FROM, Method::Get, &[], 0, false),
            Ok(None)
        );
    }
}

#[test]
fn a_dropped_body_takes_its_headers_with_it() {
    let headers = pairs(&[("content-type", "application/json"), ("x-a", "1")]);
    let dropped = hop(303, Some("/n"), FROM, Method::Post, &headers, 0, false)
        .unwrap()
        .unwrap();
    assert_eq!(dropped.headers, pairs(&[("x-a", "1")]));
    let kept = hop(307, Some("/n"), FROM, Method::Post, &headers, 0, false)
        .unwrap()
        .unwrap();
    assert_eq!(kept.headers, headers);
}

#[test]
fn a_cross_origin_hop_drops_credentials() {
    let headers = pairs(&[
        ("authorization", "Bearer t"),
        ("cookie", "a=1"),
        ("x-a", "1"),
    ]);
    let same = hop(307, Some("/n"), FROM, Method::Get, &headers, 0, false)
        .unwrap()
        .unwrap();
    assert_eq!(same.headers, headers);
    let cross = hop(
        307,
        Some("https://api.example.com:8443/n"),
        FROM,
        Method::Get,
        &headers,
        0,
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(cross.headers, pairs(&[("x-a", "1")]));
    assert_eq!(cross.target.origin, "https://api.example.com:8443");
    // Leaving the default port out names the same origin.
    let port = hop(
        307,
        Some("https://port.example.com/n"),
        "https://port.example.com:443/a",
        Method::Get,
        &headers,
        0,
        false,
    )
    .unwrap()
    .unwrap();
    assert_eq!(port.headers, headers);
}

#[test]
fn a_hop_outside_the_list_is_refused() {
    let cases = [
        "https://evil.test/",
        "https://www.example.com/",
        "https://example.com:8443/",
        "https://10.0.0.1/",
        "https://user:pw@example.com/",
        "ftp://example.com/",
        "http://[::1",
    ];
    for location in cases {
        assert_eq!(
            hop(302, Some(location), FROM, Method::Get, &[], 0, true),
            Err(REDIRECT_REFUSED),
            "{location}"
        );
    }
    let list = origins();
    let url = Url::parse(FROM).unwrap();
    let sent = Sent {
        url: &url,
        method: Method::Get,
        headers: &[],
        hops: 0,
    };
    let refused = next_hop(302, Some(b"/caf\xe9"), sent, consent(&list, false)).unwrap_err();
    assert_eq!((refused.code, refused.reason), REDIRECT_REFUSED);
}

#[test]
fn https_never_redirects_to_http() {
    assert_eq!(
        hop(
            302,
            Some("http://127.0.0.1:8080/"),
            FROM,
            Method::Get,
            &[],
            0,
            true
        ),
        Err(REDIRECT_REFUSED)
    );
    assert_eq!(
        hop(
            302,
            Some("http://example.com/"),
            FROM,
            Method::Get,
            &[],
            0,
            true
        ),
        Err(REDIRECT_REFUSED)
    );
    // A dev origin may redirect to a listed public one.
    let up = hop(
        302,
        Some("https://example.com/"),
        "http://127.0.0.1:8080/a",
        Method::Get,
        &[],
        0,
        true,
    )
    .unwrap()
    .unwrap();
    assert_eq!(up.target.origin, "https://example.com");
    // A dev hop is refused with developer mode off.
    assert_eq!(
        hop(
            302,
            Some("http://127.0.0.1:8080/b"),
            "http://127.0.0.1:8080/a",
            Method::Get,
            &[],
            0,
            false
        ),
        Err(REDIRECT_REFUSED)
    );
}

#[test]
fn the_sixth_hop_is_refused() {
    assert!(hop(
        302,
        Some("/n"),
        FROM,
        Method::Get,
        &[],
        MAX_REDIRECTS - 1,
        false
    )
    .unwrap()
    .is_some());
    assert_eq!(
        hop(
            302,
            Some("/n"),
            FROM,
            Method::Get,
            &[],
            MAX_REDIRECTS,
            false
        ),
        Err(TOO_MANY)
    );
}

#[test]
fn a_redirect_without_location_is_refused() {
    assert_eq!(
        hop(302, None, FROM, Method::Get, &[], 0, false),
        Err(TOO_MANY)
    );
}

#[test]
fn a_relative_location_resolves_against_the_current_url() {
    let cases = [
        ("/next?x=1", "https://example.com/next?x=1"),
        ("c", "https://example.com/a/c"),
        ("../c", "https://example.com/c"),
        ("?q=2", "https://example.com/a/b?q=2"),
        ("/n#frag", "https://example.com/n"),
        ("//api.example.com:8443/z", "https://api.example.com:8443/z"),
    ];
    for (location, expected) in cases {
        let next = hop(302, Some(location), FROM, Method::Get, &[], 0, false)
            .unwrap()
            .unwrap();
        assert_eq!(next.target.url.as_str(), expected, "{location}");
    }
}
