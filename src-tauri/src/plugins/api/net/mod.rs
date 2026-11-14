/*
 * Plugin network requests. The guard (`address`, `policy`) is pure: it decides which addresses, URLs,
 * headers, methods, bodies and redirect hops a request may use, and every check fails closed. The
 * engine (`resolve`, `client`, `fetch`, `stream`, `socket`) makes the requests and asks the guard
 * before each connection, and reports what arrives later through a `sink`.
 */

// No method calls the engine yet; only the tests reach this module.
#![allow(dead_code)]

mod address;
mod client;
mod fetch;
mod policy;
mod proxy;
mod resolve;
pub(crate) mod sink;
mod socket;
pub(crate) mod state;
mod stream;
#[cfg(test)]
mod test_server;

// ---- Limits ----

/// Longest request URL accepted, in bytes.
pub const MAX_URL_BYTES: usize = 8_192;
pub const MAX_HEADERS: usize = 32;
pub const MAX_HEADER_NAME: usize = 64;
pub const MAX_HEADER_VALUE: usize = 4_096;
/// Sum of every request header's name and value bytes.
pub const MAX_HEADERS_TOTAL: usize = 16_384;
pub const MAX_REQUEST_BODY: usize = 1_048_576;
pub const MAX_RESPONSE_BODY: usize = 8 * 1_048_576;
/// Redirects followed for one request; the next one is refused.
pub const MAX_REDIRECTS: usize = 5;

// ---- Refusal reasons ----

pub const FORBIDDEN_HEADER: &str = "forbidden_header";
pub const ORIGIN_NOT_LISTED: &str = "origin_not_listed";
pub const REDIRECT_NOT_LISTED: &str = "redirect_not_listed";
pub const BLOCKED_ADDRESS: &str = "blocked_address";
pub const DEV_ONLY: &str = "dev_only";
pub const REQUEST_BODY: &str = "request_body";
pub const RESPONSE_BODY: &str = "response_body";
pub const DNS: &str = "dns";
pub const CONNECT: &str = "connect";
pub const TLS: &str = "tls";
pub const PROTOCOL: &str = "protocol";
pub const CLOSED: &str = "closed";
pub const REDIRECT: &str = "redirect";
/// A socket upgrade the server refused or answered wrongly.
pub const HANDSHAKE: &str = "handshake";
/// The close reason, and log reason, of a socket Plisto ended for passing an incoming limit.
pub const PLISTO_LIMIT: &str = "plisto_limit";
/// A `dns`, `connect`, `tls` or `closed` failure while Windows has a proxy configured.
pub const PROXY: &str = "proxy";
/// A stream that received no byte for its idle time, with `timeout`.
pub const IDLE: &str = "idle";
/// A stream whose page acknowledged nothing for `STALL_MS` while data waited on it.
pub const STALLED: &str = "stalled";

/// The plugin API code a refusal maps to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetCode {
    InvalidArgs,
    Denied,
    TooLarge,
    Network,
}

/// Why a request may not go ahead. Every field is fixed text: a refusal never carries the URL, a
/// header value or an address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: NetCode,
    pub reason: Option<&'static str>,
    pub message: &'static str,
}

impl Refusal {
    pub fn invalid_args(message: &'static str) -> Refusal {
        Refusal {
            code: NetCode::InvalidArgs,
            reason: None,
            message,
        }
    }

    pub fn forbidden_header() -> Refusal {
        Refusal {
            code: NetCode::InvalidArgs,
            reason: Some(FORBIDDEN_HEADER),
            message: "A request header is set by Plisto and cannot be sent.",
        }
    }

    pub fn denied(reason: &'static str) -> Refusal {
        Refusal {
            code: NetCode::Denied,
            reason: Some(reason),
            message: "This call is not permitted.",
        }
    }

    pub fn request_body() -> Refusal {
        Refusal {
            code: NetCode::TooLarge,
            reason: Some(REQUEST_BODY),
            message: "The request body is too large.",
        }
    }

    pub fn response_body() -> Refusal {
        Refusal {
            code: NetCode::TooLarge,
            reason: Some(RESPONSE_BODY),
            message: "The response body is too large.",
        }
    }

    pub fn network(reason: &'static str) -> Refusal {
        Refusal {
            code: NetCode::Network,
            reason: Some(reason),
            message: "The request could not be completed.",
        }
    }
}
