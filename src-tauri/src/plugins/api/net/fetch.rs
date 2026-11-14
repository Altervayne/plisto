/*
 * One buffered plugin request, start to end. The URL, headers and body pass the guard before anything
 * is sent. Redirects are followed here, not by the client: each hop is checked against the plugin's
 * own origins before its connection opens. The body is read up to the cap and no further, the whole
 * call runs under its deadline, and ending the call's entry (abort, frame gone, stopped) drops the
 * connection. Every call that gets past the URL check leaves one log entry, holding the origin only.
 */

// -- Library Imports --
use std::error::Error;
use std::future::Future;
use std::io;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::LOCATION;
use reqwest::{Client, Response};
use tauri::Url;
use tokio::sync::oneshot;

// -- Local Imports --
use super::client::Clients;
use super::policy::{self, Consent, Method, ResponseHeaders, Sent, Target, Transport};
use super::resolve::GuardError;
use super::state::{CancelFn, EndReason, Kind, LogKind, NetLogEntry, NetState};
use super::{Refusal, CLOSED, CONNECT, MAX_RESPONSE_BODY, PROTOCOL, REDIRECT, TLS};
use crate::plugins::api::error::ApiError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedirectMode {
    Follow,
    /// A 3xx is the result.
    Manual,
    /// A 3xx is `network` / `redirect`.
    Error,
}

/// A request in the shape the plugin asked for. Field ranges are the caller's to check; the guard's
/// checks run in `execute`.
pub struct FetchRequest {
    pub url: String,
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub redirect: RedirectMode,
    /// The whole call, from the first lookup to the last body byte.
    pub timeout: Duration,
    pub abort_key: Option<String>,
    /// Sent unless the author set a `user-agent`.
    pub user_agent: String,
}

#[derive(Debug)]
pub struct FetchResponse {
    pub status: u16,
    /// The URL that answered, after any followed redirect.
    pub url: Url,
    pub redirected: bool,
    pub headers: ResponseHeaders,
    pub body: Vec<u8>,
}

/// What the call sent and received, kept for its log entry whichever way it ends.
struct Progress {
    url: Url,
    status: Option<u16>,
    sent: u64,
    received: u64,
}

/// Runs one buffered request for plugin `id`. It holds a fetch slot until the body is read, and ends
/// with `aborted` as soon as its entry is ended.
pub async fn execute(
    clients: &Clients,
    net: &NetState,
    id: &str,
    consent: Consent<'_>,
    request: FetchRequest,
) -> Result<FetchResponse, ApiError> {
    let (cancel, cancelled) = cancel_channel();
    let running = net.open(id, Kind::Fetch, request.abort_key.as_deref(), cancel)?;
    let target = policy::check_url(&request.url, Transport::Fetch, consent)?;

    let at_ms = unix_ms();
    let started = Instant::now();
    let mut progress = Progress {
        url: target.url.clone(),
        status: None,
        sent: 0,
        received: 0,
    };
    let checked = policy::check_headers(&request.headers).and_then(|headers| {
        policy::check_body(request.method, request.body.len())?;
        Ok(headers)
    });
    let outcome = match checked {
        Err(refusal) => Err(refusal.into()),
        Ok(headers) => {
            let work = run(clients, consent, &request, target, headers, &mut progress);
            // Leaving the select drops the losing future, and with it any open connection.
            tokio::select! {
                biased;
                error = cancelled => Err(error),
                done = tokio::time::timeout(request.timeout, work) => {
                    done.unwrap_or_else(|_| Err(ApiError::timeout()))
                }
            }
        }
    };
    drop(running);
    net.record(
        id,
        log_entry(
            request.method,
            &progress,
            &outcome,
            at_ms,
            started.elapsed(),
        ),
    );
    outcome
}

/// The entry's cancel callback and the future it resolves. The callback only sends: it never blocks
/// and never fails, and the request future, woken by it, drops its connection.
fn cancel_channel() -> (CancelFn, impl Future<Output = ApiError>) {
    let (tx, rx) = oneshot::channel::<EndReason>();
    let cancel: CancelFn = Box::new(move |why| {
        let _ = tx.send(why);
    });
    let cancelled = async move {
        match rx.await.ok().and_then(EndReason::error) {
            Some(error) => error,
            None => std::future::pending().await,
        }
    };
    (cancel, cancelled)
}

async fn run(
    clients: &Clients,
    consent: Consent<'_>,
    request: &FetchRequest,
    target: Target,
    mut headers: Vec<(String, String)>,
    progress: &mut Progress,
) -> Result<FetchResponse, ApiError> {
    let mut url = target.url;
    let mut kind = target.kind;
    let mut method = request.method;
    let mut with_body = method.may_carry_body();
    let mut hops = 0;
    loop {
        progress.url = url.clone();
        let client = clients.get(kind)?;
        let body = with_body.then_some(request.body.as_slice());
        let mut response = send(client, method, &url, &headers, &request.user_agent, body)
            .await
            .map_err(|error| map_transport_error(&error))?;
        progress.sent += body.map_or(0, |b| b.len() as u64);
        let status = response.status().as_u16();
        progress.status = Some(status);

        if request.redirect != RedirectMode::Manual {
            let location = response.headers().get(LOCATION).map(|v| v.as_bytes());
            let sent = Sent {
                url: &url,
                method,
                headers: &headers,
                hops,
            };
            match (
                request.redirect,
                policy::next_hop(status, location, sent, consent),
            ) {
                (_, Ok(None)) => {}
                (RedirectMode::Error, _) => return Err(Refusal::network(REDIRECT).into()),
                (_, Err(refusal)) => return Err(refusal.into()),
                (_, Ok(Some(hop))) => {
                    url = hop.target.url;
                    kind = hop.target.kind;
                    method = hop.method;
                    with_body &= hop.keep_body;
                    headers = hop.headers;
                    hops += 1;
                    continue;
                }
            }
        }

        let body = read_body(&mut response, method, progress).await?;
        let raw = response.headers().iter();
        let headers = policy::response_headers(raw.map(|(n, v)| (n.as_str(), v.as_bytes())));
        return Ok(FetchResponse {
            status,
            url,
            redirected: hops > 0,
            headers,
            body,
        });
    }
}

fn wire_method(method: Method) -> reqwest::Method {
    match method {
        Method::Get => reqwest::Method::GET,
        Method::Head => reqwest::Method::HEAD,
        Method::Post => reqwest::Method::POST,
        Method::Put => reqwest::Method::PUT,
        Method::Patch => reqwest::Method::PATCH,
        Method::Delete => reqwest::Method::DELETE,
    }
}

async fn send(
    client: &Client,
    method: Method,
    url: &Url,
    headers: &[(String, String)],
    user_agent: &str,
    body: Option<&[u8]>,
) -> reqwest::Result<Response> {
    let mut builder = client.request(wire_method(method), url.clone());
    for (name, value) in policy::outgoing_headers(headers.to_vec(), user_agent) {
        builder = builder.header(name, value);
    }
    if let Some(body) = body {
        builder = builder.body(body.to_vec());
    }
    builder.send().await
}

/// Reads the body up to `MAX_RESPONSE_BODY`. A declared length past the cap is refused before any
/// byte is read; a body without one is refused at the first chunk past the cap.
async fn read_body(
    response: &mut Response,
    method: Method,
    progress: &mut Progress,
) -> Result<Vec<u8>, ApiError> {
    if method == Method::Head {
        return Ok(Vec::new());
    }
    let declared = response.content_length().unwrap_or(0);
    if declared > MAX_RESPONSE_BODY as u64 {
        return Err(Refusal::response_body().into());
    }
    let mut body = Vec::with_capacity(declared as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| map_transport_error(&error))?
    {
        progress.received += chunk.len() as u64;
        if body.len() + chunk.len() > MAX_RESPONSE_BODY {
            return Err(Refusal::response_body().into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Names a client failure with a fixed reason. A refusal raised by the guarded resolver keeps its
/// own code and reason. Malformed bytes are `protocol`; a connection that ended early, before the
/// response or inside its body, is `closed`.
pub fn map_transport_error(error: &reqwest::Error) -> ApiError {
    let mut tls = false;
    let mut malformed = false;
    let mut closed = false;
    for cause in causes(error) {
        if let Some(GuardError(refusal)) = cause.downcast_ref::<GuardError>() {
            return (*refusal).into();
        }
        tls |= cause.is::<rustls::Error>();
        if let Some(hyper) = cause.downcast_ref::<hyper::Error>() {
            closed |= hyper.is_incomplete_message();
        }
        if let Some(io) = cause.downcast_ref::<io::Error>() {
            malformed |= io.kind() == io::ErrorKind::InvalidData;
            closed |= matches!(
                io.kind(),
                io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::UnexpectedEof
            );
        }
    }
    let reason = if tls {
        TLS
    } else if error.is_connect() {
        CONNECT
    } else if malformed {
        PROTOCOL
    } else if closed || error.is_body() {
        CLOSED
    } else {
        PROTOCOL
    };
    Refusal::network(reason).into()
}

/// Every error in the chain. `io::Error::source` skips the error it wraps, so that one is taken
/// with `get_ref` instead.
fn causes<'a>(error: &'a (dyn Error + 'static)) -> Vec<&'a (dyn Error + 'static)> {
    let mut chain = Vec::new();
    let mut next = Some(error);
    while let Some(cause) = next {
        chain.push(cause);
        next = match cause
            .downcast_ref::<io::Error>()
            .and_then(io::Error::get_ref)
        {
            Some(inner) => Some(inner as &(dyn Error + 'static)),
            None => cause.source(),
        };
    }
    chain
}

fn log_entry(
    method: Method,
    progress: &Progress,
    outcome: &Result<FetchResponse, ApiError>,
    at_ms: u64,
    elapsed: Duration,
) -> NetLogEntry {
    let mut entry = NetLogEntry::new(LogKind::Fetch, method.as_str(), &progress.url, at_ms);
    entry.status = progress.status;
    entry.error = outcome.as_ref().err().map(error_text);
    entry.sent = progress.sent;
    entry.received = progress.received;
    entry.ms = elapsed.as_millis() as u64;
    entry
}

/// `code` or `code/reason`, with the code's wire name.
fn error_text(error: &ApiError) -> String {
    let code = serde_json::to_value(error.code)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    match error.reason {
        Some(reason) => format!("{code}/{reason}"),
        None => code,
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests;
