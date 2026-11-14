/*
 * Test fixtures for the plugin network engine: a throwaway CA, a hand-rolled HTTP/1.1 server on
 * 127.0.0.1 (over TLS, or plain for the developer path) and a scripted resolver. The server answers
 * one request per connection and closes it, counts connections as they are accepted, records each
 * request, and counts the responses the client cut off by closing its end. Paths under `/ws` are
 * WebSocket routes, upgraded by hand and then run on the same frame codec the client uses.
 */

// -- Library Imports --
use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

// -- Local Imports --
use super::resolve::{Lookup, LookupFuture};
use super::socket::handshake::accept_for;

/// Length of the `/bin` body.
pub const BIN_LEN: usize = 256 * 1024;
/// What `/big` declares in `content-length`.
pub const BIG_LEN: usize = 9 * 1_048_576;
/// Length of the one message `/ws-big` sends.
pub const WS_BIG_LEN: usize = 2 * 1_048_576;
/// What `/ws-close` closes with.
pub const WS_CLOSE_CODE: u16 = 4001;
pub const WS_CLOSE_REASON: &str = "done";

/// The byte at `i` of every generated body.
pub fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

// ---- Certificates ----

pub struct TestCa {
    issuer: Issuer<'static, KeyPair>,
    der: CertificateDer<'static>,
}

impl TestCa {
    pub fn new() -> TestCa {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let der = params.self_signed(&key).unwrap().der().clone();
        TestCa {
            issuer: Issuer::new(params, key),
            der,
        }
    }

    pub fn root(&self) -> reqwest::Certificate {
        reqwest::Certificate::from_der(&self.der).unwrap()
    }

    fn server_config(&self, names: &[&str]) -> ServerConfig {
        let key = KeyPair::generate().unwrap();
        let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
        let cert = CertificateParams::new(names)
            .unwrap()
            .signed_by(&key, &self.issuer)
            .unwrap();
        let key = PrivateKeyDer::from(PrivatePkcs8KeyDer::from(key.serialize_der()));
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert.der().clone()], key)
            .unwrap()
    }
}

// ---- Server ----

#[derive(Clone, Debug)]
pub struct Head {
    pub method: String,
    pub path: String,
    /// Lowercase names, in the order received.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Default)]
struct Record {
    connections: AtomicUsize,
    cut_off: AtomicUsize,
    heads: Mutex<Vec<Head>>,
    /// The code of each close frame a WebSocket route received.
    ws_closes: Mutex<Vec<u16>>,
}

pub struct TestServer {
    pub port: u16,
    record: Arc<Record>,
}

impl TestServer {
    /// A TLS server whose certificate, signed by `ca`, names `names`.
    pub async fn tls(ca: &TestCa, names: &[&str]) -> TestServer {
        let acceptor = TlsAcceptor::from(Arc::new(ca.server_config(names)));
        TestServer::start(Some(acceptor)).await
    }

    pub async fn plain() -> TestServer {
        TestServer::start(None).await
    }

    async fn start(acceptor: Option<TlsAcceptor>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let record = Arc::new(Record::default());
        let shared = record.clone();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                shared.connections.fetch_add(1, Ordering::SeqCst);
                let record = shared.clone();
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    match acceptor {
                        Some(acceptor) => {
                            if let Ok(tls) = acceptor.accept(tcp).await {
                                serve(tls, record).await;
                            }
                        }
                        None => serve(tcp, record).await,
                    }
                });
            }
        });
        TestServer { port, record }
    }

    pub fn connections(&self) -> usize {
        self.record.connections.load(Ordering::SeqCst)
    }

    pub fn heads(&self) -> Vec<Head> {
        self.record.heads.lock().unwrap().clone()
    }

    /// Waits up to 5 s until `count` responses were cut off by the client closing the connection.
    pub async fn saw_close(&self, count: usize) -> bool {
        for _ in 0..250 {
            if self.record.cut_off.load(Ordering::SeqCst) >= count {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    /// Waits up to 5 s until a WebSocket route received a close frame with `code`.
    pub async fn saw_ws_close(&self, code: u16) -> bool {
        for _ in 0..250 {
            if self.record.ws_closes.lock().unwrap().contains(&code) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }
}

async fn serve<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, record: Arc<Record>) {
    let Some(head) = read_head(&mut stream).await else {
        return;
    };
    record.heads.lock().unwrap().push(head.clone());
    if head.path.starts_with("/ws") {
        return serve_ws(stream, &head, &record).await;
    }
    if respond(&mut stream, &head).await.is_err() {
        record.cut_off.fetch_add(1, Ordering::SeqCst);
    }
    let _ = stream.shutdown().await;
}

async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Option<Head> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if buf.len() > 65_536 {
            return None;
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let text = std::str::from_utf8(&buf[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split(' ');
    let method = request.next()?.to_string();
    let path = request.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[end + 4..].to_vec();
    while body.len() < length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Head {
        method,
        path,
        headers,
        body,
    })
}

async fn write_response<S: AsyncWrite + Unpin>(
    stream: &mut S,
    status: u16,
    headers: &[(&str, &str)],
    body: &[u8],
) -> io::Result<()> {
    let mut out = format!("HTTP/1.1 {status} X\r\n");
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str(&format!(
        "content-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    ));
    stream.write_all(out.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

/// Writes chunked body pieces of `size` bytes every `every` until the client closes the connection,
/// which is the error returned, or until `limit` pieces were sent.
async fn write_chunks<S: AsyncWrite + Unpin>(
    stream: &mut S,
    size: usize,
    every: Duration,
    limit: usize,
) -> io::Result<()> {
    stream
        .write_all(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n")
        .await?;
    let piece = vec![b'x'; size];
    for _ in 0..limit {
        stream.write_all(format!("{size:x}\r\n").as_bytes()).await?;
        stream.write_all(&piece).await?;
        stream.write_all(b"\r\n").await?;
        stream.flush().await?;
        if !every.is_zero() {
            tokio::time::sleep(every).await;
        }
    }
    stream.write_all(b"0\r\n\r\n").await?;
    stream.flush().await
}

/// Routes:
/// - `/echo`: the request body back.
/// - `/bin`: `BIN_LEN` bytes of `pattern`.
/// - `/big`: declares `BIG_LEN` bytes and sends none; `/big?chunked` sends chunks with no length.
/// - `/slow`: a 1 KiB chunk every 50 ms.
/// - `/redirect/<n>`: 302 to `/redirect/<n - 1>`, down to a 200 at 0.
/// - `/to/<status>/<url>`: that redirect status to that URL.
/// - `/set-cookie`: two cookies between three other headers.
/// - `/status/<n>`: that status.
/// - `/close`: no response; the connection closes after the request.
/// - `/bad-chunk`: a chunked body whose size line is not hex.
/// - `/short`: declares 100 bytes, sends 10 and closes.
async fn respond<S: AsyncWrite + Unpin>(stream: &mut S, head: &Head) -> io::Result<()> {
    let (path, query) = head.path.split_once('?').unwrap_or((&head.path, ""));
    let mut parts = path.trim_start_matches('/').splitn(3, '/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("echo"), None, None) => {
            write_response(
                stream,
                200,
                &[("content-type", "application/octet-stream")],
                &head.body,
            )
            .await
        }
        (Some("bin"), None, None) => write_response(stream, 200, &[], &pattern(BIN_LEN)).await,
        (Some("big"), None, None) if query == "chunked" => {
            write_chunks(stream, 64 * 1024, Duration::ZERO, 1024).await
        }
        (Some("big"), None, None) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-length: {BIG_LEN}\r\nconnection: close\r\n\r\n"
            );
            stream.write_all(head.as_bytes()).await?;
            stream.flush().await?;
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok(())
        }
        (Some("slow"), None, None) => {
            write_chunks(stream, 1024, Duration::from_millis(50), 600).await
        }
        (Some("redirect"), Some(n), None) => {
            let n: u32 = n.parse().unwrap_or(0);
            if n == 0 {
                write_response(stream, 200, &[], b"done").await
            } else {
                let location = format!("/redirect/{}", n - 1);
                write_response(stream, 302, &[("location", &location)], b"").await
            }
        }
        (Some("to"), Some(status), Some(url)) => {
            let status = status.parse().unwrap_or(302);
            let url = match query {
                "" => url.to_string(),
                query => format!("{url}?{query}"),
            };
            write_response(stream, status, &[("location", &url)], b"").await
        }
        (Some("set-cookie"), None, None) => {
            let headers = [
                ("x-a", "1"),
                ("set-cookie", "a=1; Path=/"),
                ("x-b", "2"),
                ("set-cookie", "b=2"),
                ("x-c", "3"),
            ];
            write_response(stream, 200, &headers, b"").await
        }
        (Some("status"), Some(n), None) => {
            write_response(stream, n.parse().unwrap_or(500), &[], b"status").await
        }
        (Some("close"), None, None) => Ok(()),
        (Some("bad-chunk"), None, None) => {
            let raw = "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\nzz\r\nabc\r\n";
            stream.write_all(raw.as_bytes()).await?;
            stream.flush().await
        }
        (Some("short"), None, None) => {
            let raw =
                "HTTP/1.1 200 OK\r\ncontent-length: 100\r\nconnection: close\r\n\r\n0123456789";
            stream.write_all(raw.as_bytes()).await?;
            stream.flush().await
        }
        _ => write_response(stream, 404, &[], b"").await,
    }
}

// ---- WebSocket routes ----

/// Routes:
/// - `/ws`: echoes text and binary; answers the first offered protocol, or `?choose=<p>`.
/// - `/ws-close`: closes with `WS_CLOSE_CODE` and `WS_CLOSE_REASON`.
/// - `/ws-drop`: drops the connection with no close frame.
/// - `/ws-flood`: sends text messages as fast as it can.
/// - `/ws-trickle`: sends a text message every 20 ms, under the rate limit, until the client goes.
/// - `/ws-big`: sends one binary message of `WS_BIG_LEN` bytes.
/// - `/ws-ping`: pings, and sends `pong-ok` once the pong arrives.
/// - `/ws-heavy`: sends 1 MiB binary messages as fast as it can.
/// - `/ws-fragments`: sends one binary message as two frames that together pass 1 MiB.
/// - `/ws-bad-utf8`: sends a text frame that is not UTF-8.
/// - `/ws-deaf`: never reads after the upgrade, and holds the connection open.
/// - `/ws-reject`: answers 403.
/// - `/ws-redirect`: answers 302 to `/ws`.
/// - `/ws-bad-accept`: answers 101 with the wrong `sec-websocket-accept`.
/// - `/ws-hang`: never answers; counts a cut-off when the client closes.
async fn serve_ws<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, head: &Head, record: &Record) {
    let (path, query) = head.path.split_once('?').unwrap_or((&head.path, ""));
    let key = head.header("sec-websocket-key").unwrap_or_default();
    let accept = match path {
        "/ws-reject" => {
            let _ = write_response(&mut stream, 403, &[], b"").await;
            return;
        }
        "/ws-redirect" => {
            let _ = write_response(&mut stream, 302, &[("location", "/ws")], b"").await;
            return;
        }
        "/ws-hang" => {
            let mut sink = [0u8; 1024];
            while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {}
            record.cut_off.fetch_add(1, Ordering::SeqCst);
            return;
        }
        "/ws-bad-accept" => accept_for("another key"),
        _ => accept_for(key),
    };
    let offered = head.header("sec-websocket-protocol").unwrap_or_default();
    let chosen = match query.strip_prefix("choose=") {
        Some(chosen) => chosen,
        None => offered.split(',').next().unwrap_or_default().trim(),
    };
    let mut answer = format!(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n"
    );
    if !chosen.is_empty() {
        answer.push_str(&format!("sec-websocket-protocol: {chosen}\r\n"));
    }
    answer.push_str("\r\n");
    if stream.write_all(answer.as_bytes()).await.is_err() || stream.flush().await.is_err() {
        return;
    }
    if let Some(frames) = raw_frames(path) {
        // Written past the codec, which would refuse to send them; then wait for the client to go.
        if stream.write_all(&frames).await.is_ok() && stream.flush().await.is_ok() {
            let mut sink = [0u8; 1024];
            while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {}
        }
        return;
    }

    let mut ws = WebSocketStream::from_raw_socket(stream, Role::Server, None).await;
    match path {
        "/ws-close" => {
            let frame = CloseFrame {
                code: CloseCode::from(WS_CLOSE_CODE),
                reason: WS_CLOSE_REASON.into(),
            };
            let _ = ws.close(Some(frame)).await;
            while let Some(Ok(_)) = ws.next().await {}
        }
        "/ws-drop" => {}
        "/ws-deaf" => tokio::time::sleep(Duration::from_secs(30)).await,
        "/ws-heavy" => {
            let message = pattern(1_048_576);
            for _ in 0..20 {
                if ws.send(Message::binary(message.clone())).await.is_err() {
                    break;
                }
            }
            while let Some(Ok(_)) = ws.next().await {}
        }
        "/ws-flood" => {
            for _ in 0..100_000 {
                if ws.send(Message::text("x")).await.is_err() {
                    break;
                }
            }
        }
        "/ws-trickle" => {
            while ws.send(Message::text("t")).await.is_ok() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        "/ws-big" => {
            let _ = ws.send(Message::binary(pattern(WS_BIG_LEN))).await;
            while let Some(Ok(_)) = ws.next().await {}
        }
        "/ws-ping" => {
            let _ = ws.send(Message::Ping(b"p".to_vec().into())).await;
            while let Some(Ok(message)) = ws.next().await {
                if matches!(message, Message::Pong(_)) {
                    let _ = ws.send(Message::text("pong-ok")).await;
                }
            }
        }
        _ => {
            while let Some(Ok(message)) = ws.next().await {
                match message {
                    Message::Text(_) | Message::Binary(_) => {
                        if ws.send(message).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(frame) => {
                        let code = frame.map_or(1005, |f| u16::from(f.code));
                        record.ws_closes.lock().unwrap().push(code);
                    }
                    _ => {}
                }
            }
        }
    }
}

/// Unmasked server frames for the routes that send what the codec would not.
fn raw_frames(path: &str) -> Option<Vec<u8>> {
    let frame = |first: u8, payload: &[u8]| {
        let mut out = vec![first, 127];
        out.extend_from_slice(&(payload.len() as u64).to_be_bytes());
        out.extend_from_slice(payload);
        out
    };
    match path {
        "/ws-bad-utf8" => Some(vec![0x81, 0x02, 0xff, 0xfe]),
        "/ws-fragments" => {
            let half = pattern(600 * 1024);
            // A binary frame without FIN, then a final continuation frame.
            let mut out = frame(0x02, &half);
            out.extend(frame(0x80, &half));
            Some(out)
        }
        _ => None,
    }
}

// ---- Resolver ----

/// Answers each name with its scripted lists in turn, repeating the last; an unknown name fails.
#[derive(Default)]
pub struct ScriptedLookup {
    answers: Mutex<HashMap<String, VecDeque<Vec<IpAddr>>>>,
    calls: AtomicUsize,
}

impl ScriptedLookup {
    pub fn answer(&self, name: &str, answers: &[&[IpAddr]]) {
        let answers = answers.iter().map(|a| a.to_vec()).collect();
        self.answers
            .lock()
            .unwrap()
            .insert(name.to_string(), answers);
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Lookup for ScriptedLookup {
    fn lookup(&self, host: &str) -> LookupFuture {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let mut answers = self.answers.lock().unwrap();
        let answer = match answers.get_mut(host) {
            Some(queue) if queue.len() > 1 => queue.pop_front(),
            Some(queue) => queue.front().cloned(),
            None => None,
        };
        Box::pin(async move { answer.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound)) })
    }
}
