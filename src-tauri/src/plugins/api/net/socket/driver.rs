/*
 * The loop that runs one open socket: it writes what the plugin queued, reads what the server sends within
 * the incoming limits and the credit window, and ends the socket with the close each cause calls for.
 */

// -- Local Imports --
use super::*;

/// What the driver owns besides the connection. Dropping it frees the socket slot.
pub(super) struct Link {
    pub(super) id: String,
    pub(super) socket: String,
    pub(super) sockets: Sockets,
    pub(super) net: NetState,
    pub(super) sink: Arc<dyn NetSink>,
    pub(super) window: Arc<Window>,
    pub(super) entry: NetLogEntry,
    pub(super) started: Instant,
    pub(super) _running: Running,
}

pub(super) struct Signals {
    pub(super) ended: oneshot::Receiver<EndReason>,
    /// Taken once it has answered.
    pub(super) close: Option<oneshot::Receiver<CloseFrame>>,
    pub(super) queued: mpsc::Receiver<Message>,
}

/// The close the plugin asked for; never resolves once the signal has answered.
async fn close_asked(close: &mut Option<oneshot::Receiver<CloseFrame>>) -> Option<CloseFrame> {
    let Some(receiver) = close.as_mut() else {
        return std::future::pending().await;
    };
    let frame = receiver.await.ok();
    *close = None;
    frame
}

/// How a socket ended: its `close` event, and the error its log entry keeps (none for a completed
/// close handshake).
pub(super) struct End {
    code: u16,
    reason: String,
    clean: bool,
    error: Option<ApiError>,
}

impl End {
    pub(super) fn dropped(error: ApiError) -> End {
        End {
            code: ABNORMAL,
            reason: String::new(),
            clean: false,
            error: Some(error),
        }
    }

    /// The close handshake completed with the server's `frame`.
    fn completed(frame: Option<CloseFrame>) -> End {
        let (code, reason) = match frame {
            Some(frame) => (u16::from(frame.code), frame.reason.as_str().to_string()),
            None => (NO_STATUS, String::new()),
        };
        End {
            code,
            reason,
            clean: true,
            error: None,
        }
    }
}

/// Incoming traffic in the current one-second window.
pub(super) struct Meter {
    window: Instant,
    messages: u32,
    bytes: usize,
}

impl Meter {
    pub(super) fn new(now: Instant) -> Meter {
        Meter {
            window: now,
            messages: 0,
            bytes: 0,
        }
    }

    /// Counts one message of `len` bytes; false once the window is past either limit.
    pub(super) fn admit(&mut self, len: usize, now: Instant) -> bool {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            *self = Meter::new(now);
        }
        self.messages += 1;
        self.bytes += len;
        self.messages <= MAX_INCOMING_PER_SECOND && self.bytes <= MAX_INCOMING_BYTES_PER_SECOND
    }
}

/// Runs the socket until it ends, and says how.
pub(super) async fn drive(mut ws: Ws, link: &mut Link, mut signals: Signals) -> End {
    let mut meter = Meter::new(Instant::now());
    let mut queue_done = false;
    let window = link.window.clone();
    loop {
        let waiting = window.full();
        if waiting {
            if window.stalled(link.sockets.clock.now()) {
                break over_limit(&mut ws, PLISTO_STALLED).await;
            }
            window.checked();
        }
        tokio::select! {
            biased;
            why = &mut signals.ended => break abandon(&mut ws, why).await,
            Some(frame) = close_asked(&mut signals.close) => {
                let deadline = TokioInstant::now() + CLOSE_GRACE;
                break close_now(&mut ws, link, &mut signals, frame, deadline).await;
            }
            message = signals.queued.recv(), if !queue_done => match message {
                Some(message) => match write_or_close(&mut ws, link, &mut signals, message).await {
                    Step::Written => {}
                    Step::Failed(error) => break End::dropped(error),
                    Step::Ended(why) => break abandon(&mut ws, why).await,
                    Step::Close(frame, deadline) => {
                        break close_now(&mut ws, link, &mut signals, frame, deadline).await;
                    }
                },
                None => queue_done = true,
            },
            () = window.acked.notified(), if waiting => {}
            () = tokio::time::sleep(TICK), if waiting => {}
            incoming = ws.next(), if !waiting => {
                let message = match incoming {
                    Some(Ok(message)) => message,
                    Some(Err(WsError::Capacity(_))) => break over_limit(&mut ws, PLISTO_LIMIT).await,
                    Some(Err(error)) => break End::dropped(ws_error(&error)),
                    None => break End::dropped(Refusal::network(CLOSED).into()),
                };
                let len = match &message {
                    Message::Text(text) => text.len(),
                    Message::Binary(bytes) => bytes.len(),
                    Message::Close(frame) => break closed_by_server(&mut ws, frame.clone()).await,
                    _ => continue,
                };
                link.entry.received += len as u64;
                if !meter.admit(len, Instant::now()) {
                    break over_limit(&mut ws, PLISTO_LIMIT).await;
                }
                window.delivered(len as u64, link.sockets.clock.now());
                link.deliver(message);
            }
        }
    }
}

/// How a write taken off the queue ended.
enum Step {
    Written,
    Failed(ApiError),
    Ended(Result<EndReason, oneshot::error::RecvError>),
    /// The plugin closed while the write ran; it finished, and the close is due by the deadline.
    Close(CloseFrame, TokioInstant),
}

/// Writes one queued message. A cancel ends the write at once. A close lets it finish, since the
/// message must reach the server before the close frame, but only within `CLOSE_GRACE`: a server
/// that stopped reading cannot hold the socket open.
async fn write_or_close(
    ws: &mut Ws,
    link: &mut Link,
    signals: &mut Signals,
    message: Message,
) -> Step {
    let writing = write(ws, link, message);
    tokio::pin!(writing);
    tokio::select! {
        biased;
        why = &mut signals.ended => Step::Ended(why),
        written = &mut writing => match written {
            Ok(()) => Step::Written,
            Err(error) => Step::Failed(error),
        },
        Some(frame) = close_asked(&mut signals.close) => {
            let deadline = TokioInstant::now() + CLOSE_GRACE;
            let bounded = tokio::time::timeout_at(deadline, &mut writing);
            match unless_ended(&mut signals.ended, bounded).await {
                Err(why) => Step::Ended(why),
                Ok(Ok(Ok(()))) => Step::Close(frame, deadline),
                Ok(Ok(Err(error))) => Step::Failed(error),
                Ok(Err(_)) => Step::Failed(Refusal::network(CLOSED).into()),
            }
        }
    }
}

/// The plugin's close, due by `deadline` and still ended at once by a cancel.
async fn close_now(
    ws: &mut Ws,
    link: &mut Link,
    signals: &mut Signals,
    frame: CloseFrame,
    deadline: TokioInstant,
) -> End {
    let closing = close_by_us(ws, link, &mut signals.queued, frame, deadline);
    match unless_ended(&mut signals.ended, closing).await {
        Ok(end) => end,
        Err(why) => abandon(ws, why).await,
    }
}

impl Link {
    fn deliver(&self, message: Message) {
        let kind = match message {
            Message::Text(text) => SocketEventKind::Text {
                data: text.as_str().to_string(),
            },
            Message::Binary(bytes) => SocketEventKind::Binary {
                data_b64: STANDARD.encode(&bytes),
            },
            _ => return,
        };
        self.sink
            .emit(NetEvent::socket(&self.id, &self.socket, kind));
    }

    /// Takes the socket out of the table, writes its log entry and emits its `close`. Dropping the
    /// link afterwards frees the slot.
    pub(super) fn finish(mut self, end: End) {
        self.sockets.table().remove(&self.socket);
        self.entry.error = end.error.as_ref().map(|error| error_text(error, None));
        self.entry.ms = self.started.elapsed().as_millis() as u64;
        self.net.record(&self.id, self.entry.clone());
        let close = SocketEventKind::Close {
            code: end.code,
            reason: end.reason,
            clean: end.clean,
        };
        self.sink
            .emit(NetEvent::socket(&self.id, &self.socket, close));
    }
}

/// Runs `work` unless the socket's entry is ended first.
async fn unless_ended<T>(
    ended: &mut oneshot::Receiver<EndReason>,
    work: impl Future<Output = T>,
) -> Result<T, Result<EndReason, oneshot::error::RecvError>> {
    tokio::select! {
        biased;
        why = ended => Err(why),
        done = work => Ok(done),
    }
}

async fn write(ws: &mut Ws, link: &mut Link, message: Message) -> Result<(), ApiError> {
    let len = message.len() as u64;
    ws.send(message).await.map_err(|error| ws_error(&error))?;
    link.entry.sent += len;
    Ok(())
}

fn ws_error(error: &WsError) -> ApiError {
    let reason = match error {
        WsError::Protocol(_) | WsError::Utf8(_) => PROTOCOL,
        _ => CLOSED,
    };
    Refusal::network(reason).into()
}

/// Writes a close frame, giving up after `CLOSE_GRACE`. The connection is dropped right after.
async fn send_close(ws: &mut Ws, code: u16, reason: &str) {
    let _ = tokio::time::timeout(CLOSE_GRACE, ws.close(Some(close_frame(code, reason)))).await;
}

/// The plugin's frame went away or the plugin stopped: 1001, without waiting on the server.
async fn abandon(ws: &mut Ws, why: Result<EndReason, oneshot::error::RecvError>) -> End {
    send_close(ws, GOING_AWAY, "").await;
    let error = ended_error(why);
    End {
        code: GOING_AWAY,
        reason: error.reason.unwrap_or_default().to_string(),
        clean: false,
        error: Some(error),
    }
}

/// A message or a rate over the limits (`plisto_limit`), or a page that stopped acknowledging
/// (`plisto_stalled`): 1008 with `reason`, without reading any further.
async fn over_limit(ws: &mut Ws, reason: &'static str) -> End {
    send_close(ws, POLICY, reason).await;
    End {
        code: POLICY,
        reason: reason.to_string(),
        clean: false,
        error: Some(Refusal::network(reason).into()),
    }
}

/// Writes what the plugin queued before asking, then the close, then waits for the server's close,
/// all by `deadline`. Messages that arrive meanwhile are counted, not delivered.
async fn close_by_us(
    ws: &mut Ws,
    link: &mut Link,
    queued: &mut mpsc::Receiver<Message>,
    frame: CloseFrame,
    deadline: TokioInstant,
) -> End {
    let answer = tokio::time::timeout_at(deadline, async {
        while let Ok(message) = queued.try_recv() {
            write(ws, link, message).await.ok()?;
        }
        ws.close(Some(frame)).await.ok()?;
        while let Some(Ok(message)) = ws.next().await {
            match message {
                Message::Close(frame) => return Some(frame),
                other => link.entry.received += other.len() as u64,
            }
        }
        None
    })
    .await;
    match answer {
        Ok(Some(frame)) => End::completed(frame),
        _ => End::dropped(Refusal::network(CLOSED).into()),
    }
}

/// The server closed: its frame is answered by the codec, then the connection drains for at most
/// `CLOSE_GRACE`.
async fn closed_by_server(ws: &mut Ws, frame: Option<CloseFrame>) -> End {
    let _ = tokio::time::timeout(CLOSE_GRACE, async {
        while let Some(Ok(_)) = ws.next().await {}
    })
    .await;
    End::completed(frame)
}
