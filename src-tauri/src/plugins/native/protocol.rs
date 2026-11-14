/*
 * The native plugin wire protocol, version 1, spoken over the child's stdin and stdout. A frame is the
 * JSON byte length in decimal, a newline, one compact JSON object, and a newline. The length comes
 * first so a reader never scans for a delimiter and can refuse an oversized frame before reading it.
 * Every message is an object tagged by `type`. A frame that is valid JSON but of an unknown type or
 * shape is reported, never fatal; a broken frame ends the stream, since nothing after it can be trusted
 * to be in step.
 */

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
// An unknown type name is logged; this keeps a hostile one short.
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
    /// Answered by `pong` with the same `seq`.
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
    /// The answer to the child's `host_call` with the same `seq`.
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
    /// The answer to `hello`, with the protocol version the child speaks.
    Ready {
        protocol: u32,
    },
    Pong {
        seq: u64,
    },
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

/// Reads one frame's JSON body. `None` is a clean end of stream between frames. Never allocates
/// more than the cap.
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

/// Parses a frame body into a message of the side's type set, `kinds` being its type names.
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

    fn read_all(bytes: &[u8]) -> Vec<Result<Option<Vec<u8>>, FrameError>> {
        let mut r = Cursor::new(bytes.to_vec());
        let mut out = Vec::new();
        loop {
            let next = read_frame(&mut r);
            let done = !matches!(next, Ok(Some(_)));
            out.push(next);
            if done {
                return out;
            }
        }
    }

    fn host_messages() -> Vec<HostMessage> {
        vec![
            HostMessage::Hello {
                protocol: 1,
                plisto_version: "2.7.0".into(),
                id: "com.example.demo".into(),
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
                event: json!({"kind": "play"}),
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
                text: Some("Mirroring".into()),
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
    fn the_kind_lists_name_every_variant() {
        for m in host_messages() {
            let v = serde_json::to_value(&m).unwrap();
            assert!(HOST_KINDS.contains(&v["type"].as_str().unwrap()), "{v}");
        }
        assert_eq!(host_messages().len(), HOST_KINDS.len());
        for m in child_messages() {
            let v = serde_json::to_value(&m).unwrap();
            assert!(CHILD_KINDS.contains(&v["type"].as_str().unwrap()), "{v}");
        }
        assert_eq!(child_messages().len(), CHILD_KINDS.len());
    }

    #[test]
    fn a_frame_is_length_newline_json_newline() {
        let frame = encode(&HostMessage::Shutdown).unwrap();
        assert_eq!(frame, b"19\n{\"type\":\"shutdown\"}\n");
    }

    #[test]
    fn the_cap_is_inclusive_and_enforced_on_both_sides() {
        // A body of exactly the cap reads; one byte more is refused before it is read.
        let mut exact = format!("{MAX_FRAME}\n").into_bytes();
        exact.extend(std::iter::repeat_n(b' ', MAX_FRAME));
        exact.push(b'\n');
        assert_eq!(
            read_all(&exact)[0]
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap()
                .len(),
            MAX_FRAME
        );
        let over = format!("{}\n", MAX_FRAME + 1);
        assert_eq!(
            read_all(over.as_bytes())[0],
            Err(FrameError::TooLarge(MAX_FRAME + 1))
        );
        assert_eq!(read_all(b"99999999\n")[0], Err(FrameError::BadLength));

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
    fn a_torn_frame_ends_the_stream() {
        for bytes in [
            &b"10\n{\"type\""[..],
            b"5\n{}{}x",
            b"2\n{}",
            b"2\n{}\r\n",
            b"12",
        ] {
            assert_eq!(
                *read_all(bytes).last().unwrap(),
                Err(FrameError::Torn),
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
        }
    }

    #[test]
    fn a_bad_length_line_ends_the_stream() {
        for bytes in [
            &b"\n{}\n"[..],
            b"-2\n{}\n",
            b"+2\n{}\n",
            b"2 \n{}\n",
            b"abc\n",
            b"\xff\n",
        ] {
            assert_eq!(
                read_all(bytes)[0],
                Err(FrameError::BadLength),
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
        }
    }

    #[test]
    fn frames_after_a_good_one_still_read() {
        let mut stream = b"2\n{}\n".to_vec();
        stream.extend(encode(&ChildMessage::Pong { seq: 1 }).unwrap());
        let read = read_all(&stream);
        assert_eq!(read.len(), 3);
        assert_eq!(read[2], Ok(None));
    }

    #[test]
    fn a_non_json_frame_is_malformed_and_the_stream_goes_on() {
        let mut stream = b"3\nabc\n".to_vec();
        stream.extend(encode(&ChildMessage::Pong { seq: 2 }).unwrap());
        let mut r = Cursor::new(stream);
        let body = read_frame(&mut r).unwrap().unwrap();
        assert!(matches!(
            decode::<ChildMessage>(&body, CHILD_KINDS),
            Decoded::Malformed(_)
        ));
        let body = read_frame(&mut r).unwrap().unwrap();
        assert_eq!(
            decode::<ChildMessage>(&body, CHILD_KINDS),
            Decoded::Message(ChildMessage::Pong { seq: 2 })
        );
    }

    #[test]
    fn unknown_and_misshapen_messages_are_reported_not_fatal() {
        let cases: [(&str, bool); 8] = [
            (r#"{"type":"teleport","x":1}"#, true),
            (r#"{"type":"ready"}"#, false),
            (r#"{"type":"pong","seq":"one"}"#, false),
            (r#"{"type":7}"#, false),
            (r#"{"seq":1}"#, false),
            (r#"[1,2]"#, false),
            (r#""ready""#, false),
            (r#"{"type":"ready","protocol":1"#, false),
        ];
        for (json, unknown) in cases {
            match decode::<ChildMessage>(json.as_bytes(), CHILD_KINDS) {
                Decoded::Unknown(kind) => assert!(unknown && kind == "teleport", "{json}"),
                Decoded::Malformed(_) => assert!(!unknown, "{json}"),
                Decoded::Message(m) => panic!("{json} decoded as {m:?}"),
            }
        }
        let long = format!(r#"{{"type":"{}"}}"#, "k".repeat(5000));
        match decode::<ChildMessage>(long.as_bytes(), CHILD_KINDS) {
            Decoded::Unknown(kind) => assert_eq!(kind.len(), MAX_KIND_CHARS),
            other => panic!("{other:?}"),
        }
        // Unknown fields on a known type are ignored.
        assert_eq!(
            decode::<ChildMessage>(br#"{"type":"ready","protocol":1,"name":"x"}"#, CHILD_KINDS),
            Decoded::Message(ChildMessage::Ready { protocol: 1 })
        );
    }

    #[test]
    fn deeply_nested_json_is_refused_without_a_crash() {
        let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
        assert!(matches!(
            decode::<ChildMessage>(deep.as_bytes(), CHILD_KINDS),
            Decoded::Malformed(_)
        ));
    }
}
