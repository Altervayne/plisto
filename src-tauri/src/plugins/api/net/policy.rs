/*
 * The request policy: which URLs, headers, methods and bodies a plugin request may use, and where a
 * redirect may lead. URLs are parsed with the same WHATWG parser the HTTP client uses, so the host
 * matched here is the host the client connects to. A URL matches a consented origin only on the
 * exact scheme, host and port: no subdomain, no trailing dot, no IP literal for a public origin.
 */

// -- Library Imports --
use std::collections::HashSet;

use tauri::Url;

// -- Local Imports --
use super::{
    Refusal, DEV_ONLY, MAX_HEADERS, MAX_HEADERS_TOTAL, MAX_HEADER_NAME, MAX_HEADER_VALUE,
    MAX_REDIRECTS, MAX_REQUEST_BODY, MAX_URL_BYTES, ORIGIN_NOT_LISTED, REDIRECT,
    REDIRECT_NOT_LISTED,
};
use crate::plugins::manifest::{origin_kind, OriginKind};

// ---- URLs ----

/// What the URL is for: a fetch takes `https` (or `http` for a dev origin), a socket `wss` (or `ws`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Fetch,
    Socket,
}

/// The origins a plugin was granted, and whether developer mode is on.
#[derive(Clone, Copy, Debug)]
pub struct Consent<'a> {
    pub origins: &'a [String],
    pub dev_mode: bool,
}

/// A URL that passed the check, with the consented origin it matched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    /// The parsed URL, fragment dropped.
    pub url: Url,
    pub origin: String,
    pub kind: OriginKind,
}

const BAD_URL: &str = "The URL is not valid.";

/// Checks a request URL against the consented origins.
pub fn check_url(raw: &str, transport: Transport, consent: Consent<'_>) -> Result<Target, Refusal> {
    if raw.len() > MAX_URL_BYTES {
        return Err(Refusal::invalid_args(BAD_URL));
    }
    let url = Url::parse(raw).map_err(|_| Refusal::invalid_args(BAD_URL))?;
    // Parsing percent-encodes, so the URL that goes out can be longer than the one that came in.
    if url.as_str().len() > MAX_URL_BYTES {
        return Err(Refusal::invalid_args(BAD_URL));
    }
    check_parsed(url, transport, consent)
}

fn check_parsed(
    mut url: Url,
    transport: Transport,
    consent: Consent<'_>,
) -> Result<Target, Refusal> {
    let kind = match (transport, url.scheme()) {
        (Transport::Fetch, "https") | (Transport::Socket, "wss") => OriginKind::Public,
        (Transport::Fetch, "http") | (Transport::Socket, "ws") => OriginKind::DevLoopback,
        _ => return Err(Refusal::invalid_args("The URL scheme is not allowed.")),
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Refusal::invalid_args("The URL must not carry credentials."));
    }
    url.set_fragment(None);
    // The client skips the resolver for an IP literal, so a public origin never matches one.
    if kind == OriginKind::Public && url.domain().is_none() {
        return Err(Refusal::denied(ORIGIN_NOT_LISTED));
    }
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else {
        return Err(Refusal::denied(ORIGIN_NOT_LISTED));
    };
    let Some(origin) = consent
        .origins
        .iter()
        .find(|origin| origin_matches(origin, kind, host, port))
    else {
        return Err(Refusal::denied(ORIGIN_NOT_LISTED));
    };
    if kind == OriginKind::DevLoopback && !consent.dev_mode {
        return Err(Refusal::denied(DEV_ONLY));
    }
    Ok(Target {
        origin: origin.clone(),
        url,
        kind,
    })
}

// A consented entry that no longer passes the manifest grammar matches nothing.
fn origin_matches(origin: &str, kind: OriginKind, host: &str, port: u16) -> bool {
    if origin_kind(origin) != Ok(kind) {
        return false;
    }
    let Ok(parsed) = Url::parse(origin) else {
        return false;
    };
    parsed.host_str() == Some(host) && parsed.port_or_known_default() == Some(port)
}

/// The `http` or `https` URL a socket handshake is sent to; `None` for any other scheme.
pub fn upgrade_url(url: &Url) -> Option<Url> {
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return None,
    };
    let mut upgraded = url.clone();
    upgraded.set_scheme(scheme).ok()?;
    Some(upgraded)
}

// ---- Request headers ----

// Set by Plisto or the client, or meaningful only to a connection or a proxy.
const FORBIDDEN_HEADERS: [&str; 10] = [
    "accept-encoding",
    "connection",
    "content-length",
    "expect",
    "host",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];
const FORBIDDEN_PREFIXES: [&str; 2] = ["proxy-", "sec-websocket-"];

const BAD_HEADER: &str = "A request header is not valid.";

fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn is_forbidden(lower: &str) -> bool {
    FORBIDDEN_HEADERS.contains(&lower) || FORBIDDEN_PREFIXES.iter().any(|p| lower.starts_with(p))
}

/// Checks the author's request headers and returns them with lowercase names, in order. Names that
/// differ only in case are one header, so a repeat is refused.
pub fn check_headers(headers: &[(String, String)]) -> Result<Vec<(String, String)>, Refusal> {
    if headers.len() > MAX_HEADERS {
        return Err(Refusal::invalid_args("Too many request headers."));
    }
    let mut total = 0;
    let mut seen = HashSet::new();
    let mut checked = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        if name.len() > MAX_HEADER_NAME || !is_token(name) {
            return Err(Refusal::invalid_args(BAD_HEADER));
        }
        let lower = name.to_ascii_lowercase();
        if is_forbidden(&lower) {
            return Err(Refusal::forbidden_header());
        }
        if value.len() > MAX_HEADER_VALUE
            || !value
                .bytes()
                .all(|b| b == b'\t' || (0x20..=0x7e).contains(&b))
        {
            return Err(Refusal::invalid_args(BAD_HEADER));
        }
        total += name.len() + value.len();
        if total > MAX_HEADERS_TOTAL {
            return Err(Refusal::invalid_args("The request headers are too large."));
        }
        if !seen.insert(lower.clone()) {
            return Err(Refusal::invalid_args(BAD_HEADER));
        }
        checked.push((lower, value.clone()));
    }
    Ok(checked)
}

/// `Plisto/<version> (<plugin id>/<plugin version>)`.
pub fn user_agent(plisto_version: &str, plugin_id: &str, plugin_version: &str) -> String {
    format!("Plisto/{plisto_version} ({plugin_id}/{plugin_version})")
}

/// The headers sent: the checked author headers, the default `user-agent` unless the author set one,
/// and `accept-encoding: identity` so no response is compressed. The client adds `content-length`.
pub fn outgoing_headers(
    mut checked: Vec<(String, String)>,
    default_user_agent: &str,
) -> Vec<(String, String)> {
    if !checked.iter().any(|(name, _)| name == "user-agent") {
        checked.push(("user-agent".to_string(), default_user_agent.to_string()));
    }
    checked.push(("accept-encoding".to_string(), "identity".to_string()));
    checked
}

/// The `host` header for a URL: the port appears only when it is not the scheme's default.
pub fn host_header(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    })
}

// ---- Response headers ----

/// A response's headers as a plugin sees them: lowercase names in the order the client's header map
/// yields them, which is wire order except that a repeated name is grouped at its first position;
/// `set-cookie` moved out.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResponseHeaders {
    pub headers: Vec<(String, String)>,
    pub set_cookies: Vec<String>,
}

/// Splits raw response headers, keeping the order given. Values are read as Latin-1, so no byte is
/// lost or refused.
pub fn response_headers<'a>(raw: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> ResponseHeaders {
    let mut out = ResponseHeaders::default();
    for (name, value) in raw {
        let value: String = value.iter().map(|&b| b as char).collect();
        let name = name.to_ascii_lowercase();
        if name == "set-cookie" {
            out.set_cookies.push(value);
        } else {
            out.headers.push((name, value));
        }
    }
    out
}

// ---- Methods and bodies ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Head,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    /// Exact case only: `get` is not `GET`.
    pub fn parse(name: &str) -> Option<Method> {
        Some(match name {
            "GET" => Method::Get,
            "HEAD" => Method::Head,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "PATCH" => Method::Patch,
            "DELETE" => Method::Delete,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Head => "HEAD",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }

    pub fn may_carry_body(self) -> bool {
        !matches!(self, Method::Get | Method::Head)
    }
}

/// Checks a request body of `len` bytes; zero bytes is no body.
pub fn check_body(method: Method, len: usize) -> Result<(), Refusal> {
    if len > 0 && !method.may_carry_body() {
        return Err(Refusal::invalid_args("This method cannot send a body."));
    }
    if len > MAX_REQUEST_BODY {
        return Err(Refusal::request_body());
    }
    Ok(())
}

// ---- Redirects ----

/// The request that received a redirect.
#[derive(Clone, Copy, Debug)]
pub struct Sent<'a> {
    pub url: &'a Url,
    pub method: Method,
    /// The checked author headers, lowercase names.
    pub headers: &'a [(String, String)],
    /// Redirects already followed to reach this request.
    pub hops: usize,
}

/// The next request of a followed redirect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hop {
    pub target: Target,
    pub method: Method,
    /// Whether the original body, if any, is sent again.
    pub keep_body: bool,
    pub headers: Vec<(String, String)>,
}

// Describe a body that is no longer sent.
const BODY_HEADERS: [&str; 4] = [
    "content-type",
    "content-encoding",
    "content-language",
    "content-location",
];
// Credentials the author meant for the origin they set them on.
const CREDENTIAL_HEADERS: [&str; 2] = ["authorization", "cookie"];

// As browsers do: 301 and 302 turn POST into GET, 303 turns all but HEAD into GET, 307 and 308 keep all.
fn redirect_method(status: u16, method: Method) -> Option<(Method, bool)> {
    Some(match (status, method) {
        (303, Method::Head) => (Method::Head, false),
        (303, _) | (301 | 302, Method::Post) => (Method::Get, false),
        (301 | 302 | 307 | 308, kept) => (kept, true),
        _ => return None,
    })
}

/// Decides what follows a response: `None` when the status is not a redirect, else the next
/// request, checked against the consent before anything is sent to it.
pub fn next_hop(
    status: u16,
    location: Option<&[u8]>,
    sent: Sent<'_>,
    consent: Consent<'_>,
) -> Result<Option<Hop>, Refusal> {
    let Some((method, keep_body)) = redirect_method(status, sent.method) else {
        return Ok(None);
    };
    if sent.hops >= MAX_REDIRECTS {
        return Err(Refusal::network(REDIRECT));
    }
    let Some(location) = location else {
        return Err(Refusal::network(REDIRECT));
    };
    let not_listed = || Refusal::denied(REDIRECT_NOT_LISTED);
    let next = std::str::from_utf8(location)
        .ok()
        .and_then(|location| sent.url.join(location).ok())
        .ok_or_else(not_listed)?;
    if next.as_str().len() > MAX_URL_BYTES {
        return Err(not_listed());
    }
    // A redirect never downgrades from https.
    if sent.url.scheme() == "https" && next.scheme() != "https" {
        return Err(not_listed());
    }
    let target = check_parsed(next, Transport::Fetch, consent).map_err(|_| not_listed())?;
    let same_origin = target.url.origin() == sent.url.origin();
    let headers = sent
        .headers
        .iter()
        .filter(|(name, _)| keep_body || !BODY_HEADERS.contains(&name.as_str()))
        .filter(|(name, _)| same_origin || !CREDENTIAL_HEADERS.contains(&name.as_str()))
        .cloned()
        .collect();
    Ok(Some(Hop {
        target,
        method,
        keep_body,
        headers,
    }))
}

#[cfg(test)]
mod tests {
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
}
