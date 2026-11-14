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
/// The plugin API version `hello` announces.
pub const API_VERSION: u32 = 1;
/// The largest JSON body either side may send.
pub const MAX_FRAME: usize = 1 << 20;
// Enough digits for MAX_FRAME.
const MAX_LEN_DIGITS: usize = 7;
// An unknown type name is reported; this keeps a hostile one short.
const MAX_KIND_CHARS: usize = 32;
const STATUS_TEXT_MAX_CHARS: usize = 60;
const NAME_MAX_CHARS: usize = 64;

/// The text of a `sidebar_input` gesture. Its `Debug` output is redacted, so no log path can print it.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Gesture(String);

impl Gesture {
    pub fn new(text: impl Into<String>) -> Gesture {
        Gesture(text.into())
    }

    #[allow(dead_code)] // The sidebar input path is the first caller.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Gesture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Gesture(<redacted>)")
    }
}

/// Why a takeover is, or is no longer, held.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TakeoverReason {
    Granted,
    Released,
    Denied,
    Busy,
    User,
    NotResponding,
    Stopped,
}

/// Plisto to plugin.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMessage {
    /// The first message. `granted` lists the capability names the user granted.
    Hello {
        protocol: u32,
        api_version: u32,
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
    /// A playback event snapshot; `lost` counts the snapshots this child missed since its last `feed`.
    Feed { event: Value, lost: u64 },
    /// The answer to the child's `host_call` with the same `seq`.
    HostResult {
        seq: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<Value>,
    },
    /// The user used a sidebar toggle (`value` set) or action (`None`).
    SidebarInput {
        item_id: String,
        value: Option<bool>,
        gesture: Gesture,
    },
    /// Whether the child holds Plisto's local output, and why that changed.
    TakeoverState { held: bool, reason: TakeoverReason },
    /// The plugin's page was shown or hidden.
    Page { open: bool },
}

pub const HOST_KINDS: &[&str] = &[
    "hello",
    "ping",
    "shutdown",
    "call",
    "feed",
    "host_result",
    "sidebar_input",
    "takeover_state",
    "page",
];

/// The states a child may report through `status`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportedState {
    On,
    Idle,
    Warn,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

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
    /// A text that fails `status_text_ok` makes the frame malformed.
    Status {
        state: ReportedState,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "status_text"
        )]
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
        #[serde(default)]
        level: LogLevel,
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

/// Characters that could spoof or hide display text: refused in a status, with control characters.
fn invisible(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{61c}'
                | '\u{200b}'..='\u{200f}'
                | '\u{2028}'..='\u{202e}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{feff}'
        )
}

/// A status text, checked after trimming: 1 to 60 chars, none a control or invisible formatting char.
pub fn status_text_ok(text: &str) -> bool {
    let text = text.trim();
    (1..=STATUS_TEXT_MAX_CHARS).contains(&text.chars().count()) && !text.chars().any(invisible)
}

/// Keeps the trimmed text, so what is stored is never longer than the rule allows.
fn status_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    match Option::<String>::deserialize(d)? {
        Some(text) if status_text_ok(&text) => Ok(Some(text.trim().to_string())),
        Some(_) => Err(serde::de::Error::custom("status text is not 1-60 plain chars")),
        None => Ok(None),
    }
}

/// A `page_event` topic or relayed method name: 1 to 64 chars of `[a-z0-9_.-]`.
#[allow(dead_code)] // The relay and page-event paths are the first callers.
pub fn name_ok(name: &str) -> bool {
    (1..=NAME_MAX_CHARS).contains(&name.len())
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-'))
}

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
    /// Not JSON, not an object with a string `type`, or a known type with the wrong fields. The reason
    /// never quotes the payload.
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
        // Only name characters survive, so a child cannot forge a log line through its type tag.
        let tag = kind.chars().take(MAX_KIND_CHARS);
        return Decoded::Unknown(
            tag.map(|c| match c {
                'a'..='z' | '0'..='9' | '_' | '.' | '-' => c,
                _ => '?',
            })
            .collect(),
        );
    }
    let kind = kind.to_string();
    match serde_json::from_value(value) {
        Ok(message) => Decoded::Message(message),
        // The serde message can quote the offending value, so only the type is reported.
        Err(_) => Decoded::Malformed(format!("{kind}: wrong or missing fields")),
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
                api_version: 1,
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
                event: json!({"seq": 2, "cause": "play"}),
                lost: 3,
            },
            HostMessage::HostResult {
                seq: 3,
                ok: false,
                result: None,
                error: Some(json!({"code": "denied", "message": "no"})),
            },
            HostMessage::SidebarInput {
                item_id: "mirror".into(),
                value: Some(true),
                gesture: Gesture::new("g-1"),
            },
            HostMessage::SidebarInput {
                item_id: "reset".into(),
                value: None,
                gesture: Gesture::new("g-2"),
            },
            HostMessage::TakeoverState {
                held: false,
                reason: TakeoverReason::NotResponding,
            },
            HostMessage::Page { open: true },
        ]
    }

    fn child_messages() -> Vec<ChildMessage> {
        vec![
            ChildMessage::Ready { protocol: 1 },
            ChildMessage::Pong { seq: 9 },
            ChildMessage::Status {
                state: ReportedState::On,
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
            ChildMessage::Status {
                state: ReportedState::Idle,
                text: None,
            },
            ChildMessage::Log {
                level: LogLevel::Warn,
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
        let host_kinds: std::collections::HashSet<_> = host_messages()
            .iter()
            .map(|m| serde_json::to_value(m).unwrap()["type"].to_string())
            .collect();
        assert_eq!(host_kinds.len(), HOST_KINDS.len());
        for m in child_messages() {
            let v = serde_json::to_value(&m).unwrap();
            assert!(CHILD_KINDS.contains(&v["type"].as_str().unwrap()), "{v}");
        }
        let child_kinds: std::collections::HashSet<_> = child_messages()
            .iter()
            .map(|m| serde_json::to_value(m).unwrap()["type"].to_string())
            .collect();
        assert_eq!(child_kinds.len(), CHILD_KINDS.len());
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
            level: LogLevel::Info,
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

    fn wire(message: &impl Serialize) -> String {
        serde_json::to_string(message).unwrap()
    }

    #[test]
    fn messages_carry_the_exact_wire_field_names() {
        assert_eq!(
            wire(&host_messages()[0]),
            r#"{"type":"hello","protocol":1,"api_version":1,"plisto_version":"2.7.0","id":"com.example.demo","granted":["audio.tap"]}"#
        );
        assert_eq!(
            wire(&host_messages()[4]),
            r#"{"type":"feed","event":{"cause":"play","seq":2},"lost":3}"#
        );
        assert_eq!(
            wire(&host_messages()[6]),
            r#"{"type":"sidebar_input","item_id":"mirror","value":true,"gesture":"g-1"}"#
        );
        assert_eq!(
            wire(&host_messages()[7]),
            r#"{"type":"sidebar_input","item_id":"reset","value":null,"gesture":"g-2"}"#
        );
        assert_eq!(
            wire(&host_messages()[8]),
            r#"{"type":"takeover_state","held":false,"reason":"not_responding"}"#
        );
        assert_eq!(wire(&host_messages()[9]), r#"{"type":"page","open":true}"#);
        assert_eq!(
            wire(&child_messages()[2]),
            r#"{"type":"status","state":"on","text":"Mirroring"}"#
        );
        assert_eq!(
            wire(&child_messages()[7]),
            r#"{"type":"status","state":"idle"}"#
        );
    }

    #[test]
    fn a_feed_has_no_frame_level_seq() {
        let feed = serde_json::to_value(&host_messages()[4]).unwrap();
        assert!(feed.get("seq").is_none());
        assert_eq!(feed["event"]["seq"], 2);
        assert!(matches!(
            decode::<HostMessage>(br#"{"type":"feed","seq":1,"event":{}}"#, HOST_KINDS),
            Decoded::Malformed(_)
        ));
    }

    #[test]
    fn every_takeover_reason_has_its_snake_case_name() {
        use TakeoverReason::*;
        let all = [
            (Granted, "granted"),
            (Released, "released"),
            (Denied, "denied"),
            (Busy, "busy"),
            (User, "user"),
            (NotResponding, "not_responding"),
            (Stopped, "stopped"),
        ];
        for (reason, name) in all {
            assert_eq!(wire(&reason), format!("\"{name}\""));
        }
    }

    fn child_decode(json: &str) -> Decoded<ChildMessage> {
        decode(json.as_bytes(), CHILD_KINDS)
    }

    #[test]
    fn status_accepts_only_the_closed_vocabulary() {
        for (state, expected) in [
            ("on", ReportedState::On),
            ("idle", ReportedState::Idle),
            ("warn", ReportedState::Warn),
        ] {
            let json = format!(r#"{{"type":"status","state":"{state}"}}"#);
            assert_eq!(
                child_decode(&json),
                Decoded::Message(ChildMessage::Status {
                    state: expected,
                    text: None
                })
            );
        }
        for json in [
            r#"{"type":"status","state":"error"}"#,
            r#"{"type":"status","state":"ON"}"#,
            r#"{"type":"status"}"#,
            r#"{"type":"status","state":7}"#,
        ] {
            assert!(matches!(child_decode(json), Decoded::Malformed(_)), "{json}");
        }
    }

    #[test]
    fn status_text_is_one_to_sixty_plain_chars_after_trim() {
        assert!(status_text_ok("a"));
        assert!(status_text_ok("  padded  "));
        assert!(status_text_ok(&"e".repeat(60)));
        // Characters are counted, not bytes.
        assert!(status_text_ok(&"\u{e9}".repeat(60)));
        assert!(!status_text_ok(""));
        assert!(!status_text_ok("   "));
        assert!(!status_text_ok(&"e".repeat(61)));
        assert!(!status_text_ok("tab\there"));
        assert!(!status_text_ok("line\nbreak"));
        assert!(!status_text_ok("bell\u{7}"));
        assert!(!status_text_ok("\u{a0}\u{a0}"));

        let long = "x".repeat(61);
        for text in ["", " ", long.as_str(), "a\\u0001b"] {
            let json = format!(r#"{{"type":"status","state":"on","text":"{text}"}}"#);
            assert!(matches!(child_decode(&json), Decoded::Malformed(_)), "{json}");
        }
        assert!(matches!(
            child_decode(r#"{"type":"status","state":"on","text":null}"#),
            Decoded::Message(ChildMessage::Status { text: None, .. })
        ));
    }

    #[test]
    fn a_padded_status_text_is_stored_trimmed() {
        let json = format!(
            r#"{{"type":"status","state":"on","text":"{pad}a{pad}"}}"#,
            pad = " ".repeat(1_000_000)
        );
        assert_eq!(
            child_decode(&json),
            Decoded::Message(ChildMessage::Status {
                state: ReportedState::On,
                text: Some("a".into())
            })
        );
    }

    #[test]
    fn invisible_and_bidi_chars_are_refused_in_a_status_text() {
        assert!(!status_text_ok("\u{200b}\u{200b}"));
        assert!(!status_text_ok("\u{feff}"));
        assert!(!status_text_ok("ab\u{202e}cd"));
        assert!(!status_text_ok("ab\u{2028}cd"));
        assert!(!status_text_ok("ab\u{2029}cd"));
        assert!(!status_text_ok("ab\u{2066}cd"));
        assert!(!status_text_ok("ab\u{61c}cd"));
        assert!(!status_text_ok("ab\u{2060}cd"));
        let json = "{\"type\":\"status\",\"state\":\"on\",\"text\":\"ab\u{202e}cd\"}";
        assert!(matches!(child_decode(json), Decoded::Malformed(_)));
    }

    #[test]
    fn sixty_chars_pass_and_sixty_one_fail_after_trim() {
        assert!(status_text_ok(&format!("  {}  ", "e".repeat(60))));
        assert!(!status_text_ok(&format!("  {}  ", "e".repeat(61))));
    }

    #[test]
    fn an_unknown_type_tag_keeps_only_name_characters() {
        let json = r#"{"type":"x\nplugins: forged"}"#;
        assert_eq!(
            child_decode(json),
            Decoded::Unknown("x?plugins??forged".into())
        );
    }

    #[test]
    fn log_levels_are_closed_and_default_to_info() {
        assert_eq!(
            child_decode(r#"{"type":"log","text":"x"}"#),
            Decoded::Message(ChildMessage::Log {
                level: LogLevel::Info,
                text: "x".into()
            })
        );
        for (name, level) in [
            ("debug", LogLevel::Debug),
            ("info", LogLevel::Info),
            ("warn", LogLevel::Warn),
            ("error", LogLevel::Error),
        ] {
            let json = format!(r#"{{"type":"log","level":"{name}","text":"x"}}"#);
            assert_eq!(
                child_decode(&json),
                Decoded::Message(ChildMessage::Log {
                    level,
                    text: "x".into()
                })
            );
        }
        assert!(matches!(
            child_decode(r#"{"type":"log","level":"trace","text":"x"}"#),
            Decoded::Malformed(_)
        ));
    }

    #[test]
    fn names_are_one_to_sixty_four_lowercase_chars() {
        for ok in ["a", "levels", "ui.toast", "a-b_c.9", &"a".repeat(64)] {
            assert!(name_ok(ok), "{ok}");
        }
        for bad in ["", "Levels", "a b", "a/b", "a:b", "caf\u{e9}", &"a".repeat(65)] {
            assert!(!name_ok(bad), "{bad}");
        }
    }

    #[test]
    fn debug_output_never_shows_a_gesture() {
        let input = HostMessage::SidebarInput {
            item_id: "mirror".into(),
            value: None,
            gesture: Gesture::new("secret-gesture-token"),
        };
        let shown = format!("{input:?} {:#?}", Gesture::new("secret-gesture-token"));
        assert!(!shown.contains("secret-gesture-token"), "{shown}");
        assert!(shown.contains("mirror"));
        // The wire still carries it.
        assert!(wire(&input).contains("secret-gesture-token"));
    }
}
