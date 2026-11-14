/*
 * Plisto's native plugin wire protocol, version 1, spoken over the plugin's stdin and stdout. A frame is
 * the JSON byte length in decimal, a newline, one compact JSON object, and a newline. Every message is an
 * object tagged by `type`. The length comes first so a reader can refuse an oversized frame before
 * reading it. A frame that is valid JSON but of an unknown type or shape is reported, never fatal; a
 * broken frame ends the stream, since nothing after it can be trusted to be in step.
 *
 * This module has no dependency on the rest of the program: copy it as is.
 */

// The whole message set is kept so the module lifts intact, whether or not a plugin sends each one.
#![allow(dead_code)]

// -- Library Imports --
use std::io::{self, BufRead, Read, Write};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
/// The largest JSON body either side may send.
pub const MAX_FRAME: usize = 1 << 20;
// Enough digits for MAX_FRAME.
const MAX_LEN_DIGITS: usize = 7;
// An unknown type name is reported shortened.
const MAX_KIND_CHARS: usize = 32;

/// Plisto to plugin.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMessage {
    /// The first message. `granted` lists the capability names the user granted.
    Hello {
        protocol: u32,
        plisto_version: String,
        id: String,
        granted: Vec<String>,
    },
    /// Answer with `pong` and the same `seq`.
    Ping { seq: u64 },
    /// Exit now; the process is killed if it is still running after a short grace.
    Shutdown,
    /// A call from the plugin's own page, answered by `result` with the same `seq`.
    Call {
        seq: u64,
        method: String,
        #[serde(default)]
        args: Value,
    },
    /// A playback event snapshot.
    Feed { seq: u64, event: Value },
    /// The answer to the plugin's `host_call` with the same `seq`.
    HostResult {
        seq: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Value>,
    },
}

pub const HOST_KINDS: &[&str] = &["hello", "ping", "shutdown", "call", "feed", "host_result"];

/// Plugin to Plisto.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChildMessage {
    /// The answer to `hello`, with the protocol version the plugin speaks.
    Ready {
        protocol: u32,
    },
    Pong {
        seq: u64,
    },
    /// A state word and a line of text for the plugin's status row.
    Status {
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    /// The answer to a `call` with the same `seq`.
    Result {
        seq: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Value>,
    },
    /// Asks to hold, or release, Plisto's local output.
    Takeover {
        hold: bool,
    },
    /// A plugin API call, answered by `host_result` with the same `seq`.
    HostCall {
        seq: u64,
        method: String,
        #[serde(default)]
        args: Value,
    },
    /// Pushed to the plugin's page.
    PageEvent {
        topic: String,
        #[serde(default)]
        data: Value,
    },
    /// One line for the plugin's log.
    Log {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        level: Option<String>,
        text: String,
    },
}

pub const CHILD_KINDS: &[&str] = &[
    "ready",
    "pong",
    "status",
    "result",
    "takeover",
    "host_call",
    "page_event",
    "log",
];

/// Why a stream of frames cannot go on.
#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The length line is empty, too long, or not decimal digits.
    BadLength,
    TooLarge(usize),
    /// The stream ended inside a frame, or the body is not followed by a newline.
    Torn,
    Io(io::ErrorKind),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::BadLength => f.write_str("bad frame length"),
            FrameError::TooLarge(n) => write!(f, "frame of {n} bytes is over the 1 MiB cap"),
            FrameError::Torn => f.write_str("torn frame"),
            FrameError::Io(kind) => write!(f, "read failed: {kind}"),
        }
    }
}

/// One frame read and parsed.
#[derive(Debug, PartialEq)]
pub enum Decoded<T> {
    Message(T),
    /// Valid JSON with a `type` this side does not know; the name, shortened.
    Unknown(String),
    /// Not JSON, not an object with a string `type`, or a known type with the wrong fields.
    Malformed(String),
}

/// The full frame for a message.
pub fn encode<T: Serialize>(message: &T) -> io::Result<Vec<u8>> {
    let json = serde_json::to_vec(message).map_err(io::Error::other)?;
    if json.len() > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "message over the 1 MiB frame cap",
        ));
    }
    let mut frame = Vec::with_capacity(json.len() + MAX_LEN_DIGITS + 2);
    frame.extend_from_slice(json.len().to_string().as_bytes());
    frame.push(b'\n');
    frame.extend_from_slice(&json);
    frame.push(b'\n');
    Ok(frame)
}

/// Writes one frame with a single `write_all`, so a caller holding the writer's lock never interleaves.
pub fn write_message<T: Serialize>(w: &mut impl Write, message: &T) -> io::Result<()> {
    w.write_all(&encode(message)?)?;
    w.flush()
}

fn read_byte(r: &mut impl Read) -> Result<Option<u8>, FrameError> {
    let mut byte = [0u8];
    loop {
        match r.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) => return Ok(Some(byte[0])),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e.kind())),
        }
    }
}

/// Reads one frame's JSON body. `None` is a clean end of stream between frames. Never allocates more
/// than the cap.
pub fn read_frame(r: &mut impl BufRead) -> Result<Option<Vec<u8>>, FrameError> {
    let mut len = 0usize;
    let mut digits = 0usize;
    loop {
        match read_byte(r)? {
            None if digits == 0 => return Ok(None),
            None => return Err(FrameError::Torn),
            Some(b'\n') if digits > 0 => break,
            Some(b @ b'0'..=b'9') if digits < MAX_LEN_DIGITS => {
                len = len * 10 + usize::from(b - b'0');
                digits += 1;
            }
            Some(_) => return Err(FrameError::BadLength),
        }
    }
    if len > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => FrameError::Torn,
        kind => FrameError::Io(kind),
    })?;
    match read_byte(r)? {
        Some(b'\n') => Ok(Some(body)),
        _ => Err(FrameError::Torn),
    }
}

/// Parses a frame body into a message of this side's type set, `kinds` being its type names.
pub fn decode<T: DeserializeOwned>(body: &[u8], kinds: &[&str]) -> Decoded<T> {
    let value: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(e) => return Decoded::Malformed(format!("not JSON: {e}")),
    };
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return Decoded::Malformed("no string 'type'".into());
    };
    if !kinds.contains(&kind) {
        return Decoded::Unknown(kind.chars().take(MAX_KIND_CHARS).collect());
    }
    let kind = kind.to_string();
    match serde_json::from_value(value) {
        Ok(message) => Decoded::Message(message),
        Err(e) => Decoded::Malformed(format!("{kind}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn host_messages() -> Vec<HostMessage> {
        vec![
            HostMessage::Hello {
                protocol: 1,
                plisto_version: "2.7.0".into(),
                id: "dev.plisto.tapmeter".into(),
                granted: vec!["audio.tap".into()],
            },
            HostMessage::Ping { seq: 9 },
            HostMessage::Shutdown,
            HostMessage::Call {
                seq: 1,
                method: "plugin.ping".into(),
                args: json!({"a": [1, "x\ny"]}),
            },
            HostMessage::Feed {
                seq: 2,
                event: json!({"cause": "start"}),
            },
            HostMessage::HostResult {
                seq: 3,
                ok: false,
                result: None,
                error: Some(json!({"code": "denied"})),
            },
        ]
    }

    fn child_messages() -> Vec<ChildMessage> {
        vec![
            ChildMessage::Ready { protocol: 1 },
            ChildMessage::Pong { seq: 9 },
            ChildMessage::Status {
                state: "on".into(),
                text: Some("Metering".into()),
            },
            ChildMessage::Result {
                seq: 1,
                ok: true,
                result: Some(json!(42)),
                error: None,
            },
            ChildMessage::Takeover { hold: true },
            ChildMessage::HostCall {
                seq: 4,
                method: "ui.toast".into(),
                args: json!({"text": "hi"}),
            },
            ChildMessage::PageEvent {
                topic: "levels".into(),
                data: json!([0.5, 0.25]),
            },
            ChildMessage::Log {
                level: None,
                text: "started".into(),
            },
        ]
    }

    #[test]
    fn every_message_round_trips_through_a_frame() {
        let mut stream = Vec::new();
        for m in host_messages() {
            write_message(&mut stream, &m).unwrap();
        }
        for m in child_messages() {
            write_message(&mut stream, &m).unwrap();
        }
        let mut r = Cursor::new(stream);
        for m in host_messages() {
            let body = read_frame(&mut r).unwrap().unwrap();
            assert_eq!(
                decode::<HostMessage>(&body, HOST_KINDS),
                Decoded::Message(m)
            );
        }
        for m in child_messages() {
            let body = read_frame(&mut r).unwrap().unwrap();
            assert_eq!(
                decode::<ChildMessage>(&body, CHILD_KINDS),
                Decoded::Message(m)
            );
        }
        assert_eq!(read_frame(&mut r), Ok(None));
    }

    #[test]
    fn a_frame_is_length_newline_json_newline() {
        let frame = encode(&HostMessage::Shutdown).unwrap();
        assert_eq!(frame, b"19\n{\"type\":\"shutdown\"}\n");
    }

    #[test]
    fn the_cap_is_inclusive_on_read_and_write() {
        let mut exact = format!("{MAX_FRAME}\n").into_bytes();
        exact.extend(std::iter::repeat_n(b' ', MAX_FRAME));
        exact.push(b'\n');
        let body = read_frame(&mut Cursor::new(exact)).unwrap().unwrap();
        assert_eq!(body.len(), MAX_FRAME);

        let over = format!("{}\n", MAX_FRAME + 1);
        assert_eq!(
            read_frame(&mut Cursor::new(over.into_bytes())),
            Err(FrameError::TooLarge(MAX_FRAME + 1))
        );
        assert_eq!(
            read_frame(&mut Cursor::new(b"99999999\n".to_vec())),
            Err(FrameError::BadLength)
        );

        let big = ChildMessage::Log {
            level: None,
            text: "x".repeat(MAX_FRAME),
        };
        assert_eq!(
            encode(&big).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn a_broken_frame_ends_the_stream() {
        for bytes in [&b"10\n{\"type\""[..], b"2\n{}\r\n", b"12"] {
            assert_eq!(
                read_frame(&mut Cursor::new(bytes.to_vec())),
                Err(FrameError::Torn)
            );
        }
        for bytes in [&b"\n{}\n"[..], b"-2\n{}\n", b"2 \n{}\n", b"abc\n"] {
            assert_eq!(
                read_frame(&mut Cursor::new(bytes.to_vec())),
                Err(FrameError::BadLength)
            );
        }
    }

    #[test]
    fn unknown_and_misshapen_messages_are_reported_not_fatal() {
        assert_eq!(
            decode::<HostMessage>(br#"{"type":"teleport"}"#, HOST_KINDS),
            Decoded::Unknown("teleport".into())
        );
        for json in [
            r#"{"type":"ping","seq":"one"}"#,
            r#"{"seq":1}"#,
            r#"[1]"#,
            r#"not json"#,
        ] {
            assert!(
                matches!(
                    decode::<HostMessage>(json.as_bytes(), HOST_KINDS),
                    Decoded::Malformed(_)
                ),
                "{json}"
            );
        }
        // Unknown fields on a known type are ignored.
        assert_eq!(
            decode::<HostMessage>(br#"{"type":"ping","seq":1,"extra":true}"#, HOST_KINDS),
            Decoded::Message(HostMessage::Ping { seq: 1 })
        );
    }
}
