/*
 * Plisto's native plugin wire protocol, version 1, spoken over the plugin's stdin and stdout. A frame is
 * the JSON byte length in decimal, a newline, one compact JSON object, and a newline. Every message is an
 * object tagged by `type`. The length comes first so a reader can refuse an oversized frame before
 * reading it. A frame that is valid JSON but of an unknown type or shape is reported, never fatal; a
 * broken frame ends the stream, since nothing after it can be trusted to be in step. Unknown fields on a
 * known type are ignored, which is how the protocol grows.
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
/// The plugin API version `hello` announces.
pub const API_VERSION: u32 = 1;
/// The largest JSON body either side may send.
pub const MAX_FRAME: usize = 1 << 20;
/// The longest `status` text, in characters after trimming.
pub const STATUS_TEXT_MAX_CHARS: usize = 60;
// Enough digits for MAX_FRAME.
const MAX_LEN_DIGITS: usize = 7;
// An unknown type name is reported shortened.
const MAX_KIND_CHARS: usize = 32;

/// The opaque token of a `sidebar_input`, to pass on to `ui.confirm` or `ui.open_page`. Its `Debug` output
/// is redacted, so no log line can print it.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Gesture(String);

impl Gesture {
    pub fn new(text: impl Into<String>) -> Gesture {
        Gesture(text.into())
    }

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
    /// Answer with `pong` and the same `seq`.
    Ping { seq: u64 },
    /// Exit now; the process is killed if it is still running after a short grace.
    Shutdown,
    /// A call from the plugin's own page, answered by `result` with the same `seq`. `method` is the name
    /// the page used, without the `plugin.` prefix.
    Call {
        seq: u64,
        method: String,
        #[serde(default)]
        args: Value,
    },
    /// A playback event snapshot. `event.seq` is the only feed counter; `lost` counts the snapshots this
    /// plugin missed since its previous `feed`.
    Feed { event: Value, lost: u64 },
    /// The answer to the plugin's `host_call` with the same `seq`. A failure carries `error` as an object
    /// `{code, message, reason?, retry_after_ms?}`.
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
    /// Whether the plugin holds Plisto's local output, and why that changed.
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

/// The states a plugin may report through `status`.
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
    /// The answer to `hello`, with the protocol version the plugin speaks.
    Ready {
        protocol: u32,
    },
    Pong {
        seq: u64,
    },
    /// A state and a line of text for the plugin's status row. Build `text` with `clean_status_text`:
    /// Plisto treats a text that fails `status_text_ok` as a malformed frame.
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
    /// One line for the plugin's log.
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

/// A control character, or an invisible or direction-changing one, which a status text may not hold.
fn forbidden_in_status(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{61C}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// A status text is 1 to 60 chars after trimming and holds no forbidden character.
pub fn status_text_ok(text: &str) -> bool {
    let text = text.trim();
    (1..=STATUS_TEXT_MAX_CHARS).contains(&text.chars().count())
        && !text.chars().any(forbidden_in_status)
}

/// Turns any text into one `status_text_ok` accepts: forbidden characters become spaces, the result is
/// trimmed and cut to the cap. None when nothing printable is left.
pub fn clean_status_text(raw: &str) -> Option<String> {
    let spaced: String = raw
        .chars()
        .map(|c| if forbidden_in_status(c) { ' ' } else { c })
        .collect();
    let cut: String = spaced.trim().chars().take(STATUS_TEXT_MAX_CHARS).collect();
    let text = cut.trim_end();
    (!text.is_empty()).then(|| text.to_string())
}

fn status_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let text = Option::<String>::deserialize(d)?;
    match text {
        Some(text) if !status_text_ok(&text) => Err(serde::de::Error::custom(
            "status text is not 1-60 plain chars",
        )),
        other => Ok(other),
    }
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
        // Only name characters survive, so the name is safe to print in a log line.
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

    fn host_messages() -> Vec<HostMessage> {
        vec![
            HostMessage::Hello {
                protocol: 1,
                api_version: 1,
                plisto_version: "2.7.0".into(),
                id: "dev.plisto.tapmeter".into(),
                granted: vec!["audio.tap".into()],
            },
            HostMessage::Ping { seq: 9 },
            HostMessage::Shutdown,
            HostMessage::Call {
                seq: 1,
                method: "ping".into(),
                args: json!({"a": [1, "x\ny"]}),
            },
            HostMessage::Feed {
                event: json!({"seq": 2, "cause": "start"}),
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
                text: Some("peak -6.0 dB".into()),
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
            level: LogLevel::Info,
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

    fn wire(message: &impl Serialize) -> String {
        serde_json::to_string(message).unwrap()
    }

    fn host(json: &str) -> Decoded<HostMessage> {
        decode(json.as_bytes(), HOST_KINDS)
    }

    #[test]
    fn every_host_message_decodes_from_the_json_plisto_writes() {
        let wire = [
            r#"{"type":"hello","protocol":1,"api_version":1,"plisto_version":"2.7.0","id":"dev.plisto.tapmeter","granted":["audio.tap"]}"#,
            r#"{"type":"ping","seq":9}"#,
            r#"{"type":"shutdown"}"#,
            r#"{"type":"call","seq":1,"method":"ping","args":{"a":[1,"x\ny"]}}"#,
            r#"{"type":"feed","event":{"cause":"start","seq":2},"lost":3}"#,
            r#"{"type":"host_result","seq":3,"ok":false,"error":{"code":"denied","message":"no"}}"#,
            r#"{"type":"sidebar_input","item_id":"mirror","value":true,"gesture":"g-1"}"#,
            r#"{"type":"sidebar_input","item_id":"reset","value":null,"gesture":"g-2"}"#,
            r#"{"type":"takeover_state","held":false,"reason":"not_responding"}"#,
            r#"{"type":"page","open":true}"#,
        ];
        for (json, expected) in wire.iter().zip(host_messages()) {
            assert_eq!(host(json), Decoded::Message(expected), "{json}");
        }
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
            let json = format!(r#"{{"type":"takeover_state","held":true,"reason":"{name}"}}"#);
            assert_eq!(
                host(&json),
                Decoded::Message(HostMessage::TakeoverState { held: true, reason })
            );
        }
    }

    #[test]
    fn unknown_host_types_and_fields_are_ignored_not_fatal() {
        assert_eq!(
            host(r#"{"type":"teleport","x":1}"#),
            Decoded::Unknown("teleport".into())
        );
        assert_eq!(
            host(r#"{"type":"page","open":false,"since":12,"extra":{"a":1}}"#),
            Decoded::Message(HostMessage::Page { open: false })
        );
        assert_eq!(
            host(
                r#"{"type":"hello","protocol":1,"api_version":1,"plisto_version":"9","id":"a","granted":[],"future":true}"#
            ),
            Decoded::Message(HostMessage::Hello {
                protocol: 1,
                api_version: 1,
                plisto_version: "9".into(),
                id: "a".into(),
                granted: vec![]
            })
        );
        // A feed has no frame-level seq; a stray one is an unknown field, not the counter.
        assert!(matches!(
            host(r#"{"type":"feed","seq":1,"event":{"seq":5},"lost":0}"#),
            Decoded::Message(HostMessage::Feed { lost: 0, .. })
        ));
        for json in [
            r#"{"type":"ping","seq":"one"}"#,
            r#"{"seq":1}"#,
            r#"[1]"#,
            r#"not json"#,
        ] {
            assert!(matches!(host(json), Decoded::Malformed(_)), "{json}");
        }
    }

    #[test]
    fn every_child_message_encodes_to_the_wire_plisto_reads() {
        let expected = [
            r#"{"type":"ready","protocol":1}"#,
            r#"{"type":"pong","seq":9}"#,
            r#"{"type":"status","state":"on","text":"peak -6.0 dB"}"#,
            r#"{"type":"result","seq":1,"ok":true,"result":42}"#,
            r#"{"type":"takeover","hold":true}"#,
            r#"{"type":"host_call","seq":4,"method":"ui.toast","args":{"text":"hi"}}"#,
            r#"{"type":"page_event","topic":"levels","data":[0.5,0.25]}"#,
            r#"{"type":"status","state":"idle"}"#,
            r#"{"type":"log","level":"warn","text":"started"}"#,
        ];
        for (message, json) in child_messages().iter().zip(expected) {
            assert_eq!(wire(message), json);
        }
    }

    #[test]
    fn the_status_vocabulary_and_log_levels_have_their_wire_names() {
        for (state, name) in [
            (ReportedState::On, "on"),
            (ReportedState::Idle, "idle"),
            (ReportedState::Warn, "warn"),
        ] {
            assert_eq!(wire(&state), format!("\"{name}\""));
        }
        for (level, name) in [
            (LogLevel::Debug, "debug"),
            (LogLevel::Info, "info"),
            (LogLevel::Warn, "warn"),
            (LogLevel::Error, "error"),
        ] {
            assert_eq!(wire(&level), format!("\"{name}\""));
        }
        assert_eq!(LogLevel::default(), LogLevel::Info);
    }

    #[test]
    fn status_text_is_one_to_sixty_plain_chars_after_trim() {
        assert!(status_text_ok("a"));
        assert!(status_text_ok("  padded  "));
        assert!(status_text_ok(&"e".repeat(60)));
        assert!(status_text_ok(&"\u{e9}".repeat(60)));
        assert!(!status_text_ok(""));
        assert!(!status_text_ok("   "));
        assert!(!status_text_ok(&"e".repeat(61)));
        assert!(!status_text_ok("tab\there"));
        assert!(!status_text_ok("bell\u{7}"));
        assert!(!status_text_ok("\u{200B}\u{200D}"));
        assert!(!status_text_ok("evil\u{202E}txt"));
        assert!(!status_text_ok("split\u{2028}line"));
        assert!(!status_text_ok("\u{FEFF}bom"));
    }

    #[test]
    fn a_cleaned_status_text_always_passes_the_hosts_rule() {
        let long = "x".repeat(500);
        let accents = "\u{e9}".repeat(100);
        let spaced_tail = format!("{} tail", "y".repeat(59));
        let cases = [
            "plain",
            "  padded  ",
            "tab\there",
            "line\nbreak\r\n",
            "\u{7}\u{1b}[0m",
            long.as_str(),
            accents.as_str(),
            spaced_tail.as_str(),
            "zero\u{200B}width\u{200D}",
            "rtl\u{202E}override",
            "line\u{2028}sep\u{2029}para",
            "\u{61C}\u{2066}iso\u{2069}\u{FEFF}",
        ];
        for raw in cases {
            let text = clean_status_text(raw).expect("has printable text");
            assert!(status_text_ok(&text), "{raw:?} -> {text:?}");
            assert!(text.chars().count() <= STATUS_TEXT_MAX_CHARS);
            assert_eq!(text, text.trim());
        }
        assert_eq!(clean_status_text("  padded  ").unwrap(), "padded");
        assert_eq!(clean_status_text("a\tb").unwrap(), "a b");
        assert_eq!(clean_status_text(&long).unwrap().len(), 60);
    }

    #[test]
    fn a_text_with_nothing_printable_cleans_to_none() {
        for raw in [
            "",
            "   ",
            "\n\t",
            "\u{0}\u{7}",
            "\u{200B}\u{200C}\u{200D}",
            "\u{202E}\u{2028}",
        ] {
            assert_eq!(clean_status_text(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn debug_output_never_shows_a_gesture() {
        let input = HostMessage::SidebarInput {
            item_id: "mirror".into(),
            value: None,
            gesture: Gesture::new("secret-gesture-token"),
        };
        let shown = format!("{input:?}");
        assert!(!shown.contains("secret-gesture-token"), "{shown}");
        assert!(shown.contains("mirror"));
        // The wire still carries it.
        assert!(wire(&input).contains("secret-gesture-token"));
    }

    #[test]
    fn an_unknown_type_name_keeps_only_name_characters() {
        assert_eq!(
            host(r#"{"type":"x\nforged: line"}"#),
            Decoded::Unknown("x?forged??line".into())
        );
    }

    #[test]
    fn a_status_the_host_would_refuse_does_not_decode() {
        let long = "x".repeat(61);
        for text in ["", " ", long.as_str()] {
            let json = format!(r#"{{"type":"status","state":"on","text":"{text}"}}"#);
            assert!(matches!(
                decode::<ChildMessage>(json.as_bytes(), CHILD_KINDS),
                Decoded::Malformed(_)
            ));
        }
        assert!(matches!(
            decode::<ChildMessage>(br#"{"type":"status","state":"error"}"#, CHILD_KINDS),
            Decoded::Malformed(_)
        ));
    }
}
