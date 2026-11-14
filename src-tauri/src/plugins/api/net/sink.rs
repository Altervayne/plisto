/*
 * What the network engine tells a plugin's page after a call has resolved: socket messages and the
 * close that ends each socket, stream chunks and the end or error that ends each stream. The engine
 * reports through a `NetSink` and never knows where events go. Each event serializes to the payload
 * the main window's shim reads from `plugins:net`, with `id` naming the plugin it belongs to.
 */

// -- Library Imports --
use serde::Serialize;
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

// -- Local Imports --
use crate::plugins::api::error::ApiCode;

/// Where the engine sends its events. Called from engine tasks, so it must not block.
pub trait NetSink: Send + Sync {
    fn emit(&self, event: NetEvent);
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetEvent {
    /// The plugin id.
    pub id: String,
    #[serde(flatten)]
    pub body: NetEventBody,
}

/// Each variant carries its own id field (`socket`, `stream`), so the shim tells them apart without
/// a tag.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum NetEventBody {
    Socket(SocketEvent),
    Stream(StreamEvent),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SocketEvent {
    pub socket: String,
    #[serde(flatten)]
    pub kind: SocketEventKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SocketEventKind {
    Text {
        data: String,
    },
    Binary {
        data_b64: String,
    },
    /// The last event of every socket.
    Close {
        code: u16,
        reason: String,
        clean: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StreamEvent {
    pub stream: String,
    #[serde(flatten)]
    pub kind: StreamEventKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEventKind {
    /// `seq` counts from 1 with no gap.
    Chunk { seq: u64, data_b64: String },
    /// The body is complete. The last event of its stream.
    End,
    /// The last event of a stream that did not complete.
    Error {
        code: ApiCode,
        reason: Option<&'static str>,
    },
}

impl NetEvent {
    pub fn socket(id: &str, socket: &str, kind: SocketEventKind) -> NetEvent {
        NetEvent {
            id: id.to_string(),
            body: NetEventBody::Socket(SocketEvent {
                socket: socket.to_string(),
                kind,
            }),
        }
    }

    pub fn stream(id: &str, stream: &str, kind: StreamEventKind) -> NetEvent {
        NetEvent {
            id: id.to_string(),
            body: NetEventBody::Stream(StreamEvent {
                stream: stream.to_string(),
                kind,
            }),
        }
    }
}

/// Keeps every event, in emit order, and counts the bytes of each stream's chunks.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink {
    events: Mutex<Vec<NetEvent>>,
    chunk_bytes: Mutex<HashMap<String, u64>>,
    /// Panics on each text, binary or chunk event instead of keeping it.
    panic_on_message: bool,
    /// Keeps chunk events with their data emptied.
    drop_data: bool,
}

#[cfg(test)]
impl RecordingSink {
    pub fn panicking_on_message() -> RecordingSink {
        RecordingSink {
            panic_on_message: true,
            ..RecordingSink::default()
        }
    }

    /// For long streams: chunks are counted, their data is not kept.
    pub fn dropping_data() -> RecordingSink {
        RecordingSink {
            drop_data: true,
            ..RecordingSink::default()
        }
    }

    pub fn events(&self) -> Vec<NetEvent> {
        self.events.lock().unwrap().clone()
    }

    /// The events of one socket, in emit order.
    pub fn socket_events(&self, socket: &str) -> Vec<SocketEventKind> {
        self.events()
            .into_iter()
            .filter_map(|event| match event.body {
                NetEventBody::Socket(s) if s.socket == socket => Some(s.kind),
                _ => None,
            })
            .collect()
    }

    /// The events of one stream, in emit order.
    pub fn stream_events(&self, stream: &str) -> Vec<StreamEventKind> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match &event.body {
                NetEventBody::Stream(s) if s.stream == stream => Some(s.kind.clone()),
                _ => None,
            })
            .collect()
    }

    /// The bytes the chunks of `stream` carried.
    pub fn chunk_bytes(&self, stream: &str) -> u64 {
        let counted = self.chunk_bytes.lock().unwrap();
        counted.get(stream).copied().unwrap_or(0)
    }
}

#[cfg(test)]
impl NetSink for RecordingSink {
    fn emit(&self, mut event: NetEvent) {
        let message = match &mut event.body {
            NetEventBody::Socket(socket) => !matches!(socket.kind, SocketEventKind::Close { .. }),
            NetEventBody::Stream(stream) => match &mut stream.kind {
                StreamEventKind::Chunk { data_b64, .. } => {
                    let padding = data_b64.bytes().rev().take_while(|b| *b == b'=').count();
                    let len = (data_b64.len() / 4 * 3 - padding) as u64;
                    let mut counted = self.chunk_bytes.lock().unwrap();
                    *counted.entry(stream.stream.clone()).or_default() += len;
                    if self.drop_data {
                        data_b64.clear();
                    }
                    true
                }
                _ => false,
            },
        };
        assert!(!(self.panic_on_message && message), "the sink failed");
        self.events.lock().unwrap().push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn socket_events_have_the_shapes_the_shim_reads() {
        let cases = [
            (
                SocketEventKind::Text { data: "hi".into() },
                json!({ "id": "com.example.a", "socket": "s1", "kind": "text", "data": "hi" }),
            ),
            (
                SocketEventKind::Binary {
                    data_b64: "AAE=".into(),
                },
                json!({ "id": "com.example.a", "socket": "s1", "kind": "binary", "data_b64": "AAE=" }),
            ),
            (
                SocketEventKind::Close {
                    code: 1008,
                    reason: "plisto_limit".into(),
                    clean: false,
                },
                json!({
                    "id": "com.example.a",
                    "socket": "s1",
                    "kind": "close",
                    "code": 1008,
                    "reason": "plisto_limit",
                    "clean": false
                }),
            ),
        ];
        for (kind, expected) in cases {
            let event = NetEvent::socket("com.example.a", "s1", kind);
            assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        }
    }

    #[test]
    fn stream_events_have_the_shapes_the_shim_reads() {
        let cases = [
            (
                StreamEventKind::Chunk {
                    seq: 1,
                    data_b64: "AAE=".into(),
                },
                json!({ "id": "com.example.a", "stream": "t1", "kind": "chunk", "seq": 1, "data_b64": "AAE=" }),
            ),
            (
                StreamEventKind::End,
                json!({ "id": "com.example.a", "stream": "t1", "kind": "end" }),
            ),
            (
                StreamEventKind::Error {
                    code: ApiCode::Timeout,
                    reason: Some("idle"),
                },
                json!({
                    "id": "com.example.a",
                    "stream": "t1",
                    "kind": "error",
                    "code": "timeout",
                    "reason": "idle"
                }),
            ),
            (
                StreamEventKind::Error {
                    code: ApiCode::Aborted,
                    reason: None,
                },
                json!({
                    "id": "com.example.a",
                    "stream": "t1",
                    "kind": "error",
                    "code": "aborted",
                    "reason": null
                }),
            ),
        ];
        for (kind, expected) in cases {
            let event = NetEvent::stream("com.example.a", "t1", kind);
            assert_eq!(serde_json::to_value(&event).unwrap(), expected);
        }
    }
}
