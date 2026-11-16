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
mod tests;
