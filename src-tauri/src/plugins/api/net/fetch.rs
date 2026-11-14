/*
 * One plugin request, start to end. The URL, headers and body pass the guard before anything is sent.
 * Redirects are followed here, not by the client: each hop is checked against the plugin's own origins
 * before its connection opens. A buffered request reads its body up to the cap and no further under
 * one deadline. A streamed request stops at the headers and hands the open body to its reader, which
 * writes the log entry when the stream ends. Ending a call's entry (abort, frame gone, stopped) drops
 * the connection. Every call that gets past the URL check leaves one log entry, holding the origin only.
 */

// -- Library Imports --
use std::error::Error;
use std::future::Future;
use std::io;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::LOCATION;
use reqwest::{Client, Response};
use tauri::Url;
use tokio::sync::{mpsc, oneshot};

// -- Local Imports --
use super::client::Clients;
use super::policy::{self, Consent, Method, ResponseHeaders, Sent, Target, Transport};
use super::proxy::Proxy;
use super::resolve::GuardError;
use super::state::{
    CancelFn, EndReason, Kind, LogKind, NetLogEntry, NetState, Running, StreamKind,
};
use super::{Refusal, CLOSED, CONNECT, MAX_RESPONSE_BODY, PROTOCOL, PROXY, REDIRECT, TLS};
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
    /// The whole call, from the first lookup to the last body byte; streamed, until the headers.
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
    /// The call failed sending or reading at `url`, so a proxy may explain its error.
    on_wire: bool,
    /// The transport reason a `proxy` error replaced.
    cause: Option<&'static str>,
}

impl Progress {
    fn at(url: Url) -> Progress {
        Progress {
            url,
            status: None,
            sent: 0,
            received: 0,
            on_wire: false,
            cause: None,
        }
    }
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
    let mut progress = Progress::at(target.url.clone());
    let checked = policy::check_headers(&request.headers).and_then(|headers| {
        policy::check_body(request.method, request.body.len())?;
        Ok(headers)
    });
    let outcome = match checked {
        Err(refusal) => Err(refusal.into()),
        Ok(headers) => {
            let work = async {
                let run = run(clients, consent, &request, target, headers, &mut progress);
                let done = tokio::time::timeout(request.timeout, run)
                    .await
                    .unwrap_or_else(|_| Err(ApiError::timeout()));
                match done {
                    // Past the deadline: a discovery wait never turns a failure into `timeout`.
                    Err(error) if progress.on_wire => {
                        let url = &progress.url;
                        Err(explain(clients.proxy(), error, url, &mut progress.cause).await)
                    }
                    done => done,
                }
            };
            // Leaving the select drops the losing future, and with it any open connection.
            tokio::select! {
                biased;
                error = cancelled => Err(error),
                done = work => done,
            }
        }
    };
    drop(running);
    net.record(
        id,
        log_entry(
            LogKind::Fetch,
            request.method,
            &progress,
            outcome.as_ref().err(),
            at_ms,
            started.elapsed(),
        ),
    );
    outcome
}

// ---- Streamed ----

/// The head of a streamed response.
pub struct StreamHead {
    pub status: u16,
    /// The URL that answered, after any followed redirect.
    pub url: Url,
    pub redirected: bool,
    pub headers: ResponseHeaders,
    /// None for a response without a body (`HEAD`, 204, 304): its stream entry is already released
    /// and its log entry written.
    pub body: Option<StreamBody>,
}

/// A streamed body still on its connection. Its reader reads `response`, ends when `ended` resolves,
/// adds what it reads to `log.received`, and calls `finish` once, whichever way the stream ends.
pub struct StreamBody {
    pub response: Response,
    /// The stream entry: it holds the stream slot until dropped.
    pub running: Running,
    pub ended: Ended,
    /// The URL that answered, for `explain`.
    pub url: Url,
    pub log: NetLogEntry,
    started: Instant,
}

impl StreamBody {
    /// Drops the connection and the stream slot, then writes the log entry: complete when `error` is
    /// none, `cause` being the transport reason a `proxy` error replaced.
    pub fn finish(self, net: &NetState, id: &str, error: Option<&ApiError>, cause: Option<&str>) {
        let StreamBody {
            response,
            running,
            mut log,
            started,
            ..
        } = self;
        drop(response);
        drop(running);
        log.error = error.map(|error| error_text(error, cause));
        log.ms = started.elapsed().as_millis() as u64;
        net.record(id, log);
    }
}

/// Resolves once an entry it was opened with is ended.
pub struct Ended(mpsc::UnboundedReceiver<EndReason>);

impl Ended {
    /// The `aborted` error the entry ended with. A guard dropped with `Finished` is not an end.
    pub async fn wait(&mut self) -> ApiError {
        while let Some(why) = self.0.recv().await {
            if let Some(error) = why.error() {
                return error;
            }
        }
        std::future::pending().await
    }
}

/// A cancel callback that only sends, so it never blocks and never fails.
fn signal(tx: &mpsc::UnboundedSender<EndReason>) -> CancelFn {
    let tx = tx.clone();
    Box::new(move |why| {
        let _ = tx.send(why);
    })
}

/// Sends a streamed request for plugin `id` and stops at the final response's headers. The stream
/// slot is claimed first, so a plugin at its stream cap sends nothing; the fetch slot is held only
/// until the headers, and released on every path. A request that fails before them writes its log
/// entry here and leaves no entry behind.
pub async fn open_streamed(
    clients: &Clients,
    net: &NetState,
    id: &str,
    consent: Consent<'_>,
    request: &FetchRequest,
    kind: StreamKind,
) -> Result<StreamHead, ApiError> {
    let (tx, rx) = mpsc::unbounded_channel();
    let abort_key = request.abort_key.as_deref();
    let stream = net.open(id, kind.kind(), abort_key, signal(&tx))?;
    let fetch = net.open(id, kind.head_kind(), abort_key, signal(&tx))?;
    // Once both callbacks are spent the channel closes, and `wait` stays pending.
    drop(tx);
    let mut ended = Ended(rx);
    let target = policy::check_url(&request.url, Transport::Fetch, consent)?;

    let at_ms = unix_ms();
    let started = Instant::now();
    let mut progress = Progress::at(target.url.clone());
    let checked = policy::check_headers(&request.headers).and_then(|headers| {
        policy::check_body(request.method, request.body.len())?;
        Ok(headers)
    });
    let outcome = match checked {
        Err(refusal) => Err(refusal.into()),
        Ok(headers) => {
            let work = async {
                let follow = follow(clients, consent, request, target, headers, &mut progress);
                let done = tokio::time::timeout(request.timeout, follow)
                    .await
                    .unwrap_or_else(|_| Err(ApiError::timeout()));
                match done {
                    // Past the deadline: a discovery wait never turns a failure into `timeout`.
                    Err(error) if progress.on_wire => {
                        let url = &progress.url;
                        Err(explain(clients.proxy(), error, url, &mut progress.cause).await)
                    }
                    done => done,
                }
            };
            tokio::select! {
                biased;
                error = ended.wait() => Err(error),
                done = work => done,
            }
        }
    };
    drop(fetch);
    let log_kind = kind.log_kind();
    let last = match outcome {
        Ok(last) => last,
        Err(error) => {
            let elapsed = started.elapsed();
            let entry = log_entry(log_kind, request.method, &progress, Some(&error), at_ms, elapsed);
            net.record(id, entry);
            return Err(error);
        }
    };

    let status = last.response.status().as_u16();
    let headers = header_list(&last.response);
    let log = log_entry(log_kind, request.method, &progress, None, at_ms, Duration::ZERO);
    let body = StreamBody {
        response: last.response,
        running: stream,
        ended,
        url: last.url.clone(),
        log,
        started,
    };
    let bodiless = last.method == Method::Head || status == 204 || status == 304;
    let body = if bodiless {
        body.finish(net, id, None, None);
        None
    } else {
        Some(body)
    };
    Ok(StreamHead {
        status,
        url: last.url,
        redirected: last.redirected,
        headers,
        body,
    })
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
    headers: Vec<(String, String)>,
    progress: &mut Progress,
) -> Result<FetchResponse, ApiError> {
    let Last {
        mut response,
        url,
        method,
        redirected,
    } = follow(clients, consent, request, target, headers, progress).await?;
    let status = response.status().as_u16();
    let body = match read_body(&mut response, method, progress).await {
        Ok(body) => body,
        Err(error) => {
            progress.on_wire = true;
            return Err(error);
        }
    };
    Ok(FetchResponse {
        status,
        url,
        redirected,
        headers: header_list(&response),
        body,
    })
}

/// The final response of a request, its body unread.
struct Last {
    response: Response,
    url: Url,
    /// The method of the last hop.
    method: Method,
    redirected: bool,
}

/// Sends the request and follows its redirects, each hop checked before its connection opens.
async fn follow(
    clients: &Clients,
    consent: Consent<'_>,
    request: &FetchRequest,
    target: Target,
    mut headers: Vec<(String, String)>,
    progress: &mut Progress,
) -> Result<Last, ApiError> {
    let mut url = target.url;
    let mut kind = target.kind;
    let mut method = request.method;
    let mut with_body = method.may_carry_body();
    let mut hops = 0;
    loop {
        progress.url = url.clone();
        let client = clients.get(kind)?;
        let body = with_body.then_some(request.body.as_slice());
        let response =
            match send(client, method, &url, &headers, &request.user_agent, body).await {
                Ok(response) => response,
                Err(error) => {
                    progress.on_wire = true;
                    return Err(map_transport_error(&error));
                }
            };
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

        return Ok(Last {
            response,
            url,
            method,
            redirected: hops > 0,
        });
    }
}

fn header_list(response: &Response) -> ResponseHeaders {
    let raw = response.headers().iter();
    policy::response_headers(raw.map(|(n, v)| (n.as_str(), v.as_bytes())))
}

/// Names a failure on the wire `proxy` when a proxy explains it, keeping the replaced reason in
/// `cause` for the log entry.
pub(super) async fn explain(
    proxy: &Proxy,
    error: ApiError,
    url: &Url,
    cause: &mut Option<&'static str>,
) -> ApiError {
    let reason = error.reason;
    let error = proxy.explain(error, url).await;
    if error.reason == Some(PROXY) {
        *cause = reason;
    }
    error
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
    kind: LogKind,
    method: Method,
    progress: &Progress,
    error: Option<&ApiError>,
    at_ms: u64,
    elapsed: Duration,
) -> NetLogEntry {
    let mut entry = NetLogEntry::new(kind, method.as_str(), &progress.url, at_ms);
    entry.status = progress.status;
    entry.error = error.map(|error| error_text(error, progress.cause));
    entry.sent = progress.sent;
    entry.received = progress.received;
    entry.ms = elapsed.as_millis() as u64;
    entry
}

/// `code` or `code/reason`, with the code's wire name. A `proxy` reason keeps the transport reason
/// it replaced: `network/connect+proxy`.
pub(super) fn error_text(error: &ApiError, cause: Option<&str>) -> String {
    let code = serde_json::to_value(error.code)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    match (error.reason, cause) {
        (Some(PROXY), Some(cause)) => format!("{code}/{cause}+{PROXY}"),
        (Some(reason), _) => format!("{code}/{reason}"),
        (None, _) => code,
    }
}

pub(super) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests;
