/*
 * What the network engine tells a plugin's page after a call has resolved: socket messages and the
 * close that ends each socket. The engine reports through a `NetSink` and never knows where events
 * go. Each event serializes to the payload the main window's shim reads from `plugins:net`, with `id`
 * naming the plugin it belongs to.
 */

// -- Library Imports --
use serde::Serialize;
#[cfg(test)]
use std::sync::Mutex;

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

/// Each variant carries its own id field (`socket`), so the shim tells them apart without a tag.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum NetEventBody {
    Socket(SocketEvent),
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
}

/// Keeps every event, in emit order.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink {
    events: Mutex<Vec<NetEvent>>,
    /// Panics on each text or binary event instead of keeping it.
    panic_on_message: bool,
}

#[cfg(test)]
impl RecordingSink {
    pub fn panicking_on_message() -> RecordingSink {
        RecordingSink {
            panic_on_message: true,
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
}

#[cfg(test)]
impl NetSink for RecordingSink {
    fn emit(&self, event: NetEvent) {
        let NetEventBody::Socket(socket) = &event.body;
        let message = !matches!(socket.kind, SocketEventKind::Close { .. });
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
}
