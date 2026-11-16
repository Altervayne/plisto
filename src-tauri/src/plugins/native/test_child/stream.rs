/*
 * The test child's playback stream behaviors: one plays a generated tone through `stream.play` and
 * `stream.push`, the other plays a URL. Both log every `stream` event the host sends.
 */

// -- Library Imports --
use std::io::{BufReader, Stdin};
use std::process;

use base64::Engine;
use serde_json::{json, Value};

// -- Local Imports --
use super::{next, ready, send, serve_with, CRASH_CODE};
use crate::plugins::native::protocol::{ChildMessage, HostMessage};

/// Half a second of a 440 Hz sine as base64 `pcm_s16le`, 8 kHz mono: the format `push` plays.
fn tone_b64() -> String {
    const RATE: usize = 8000;
    let bytes: Vec<u8> = (0..RATE / 2)
        .flat_map(|n| {
            let phase = 2.0 * std::f64::consts::PI * 440.0 * n as f64 / RATE as f64;
            ((phase.sin() * 8000.0) as i16).to_le_bytes()
        })
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Plays a generated tone through `stream.play`, pushes it once the item is known, and logs
/// every `stream` event it hears. Once the push is answered it calls `stream.stop`, or
/// with a parameter exits instead.
pub(super) fn push(input: &mut BufReader<Stdin>, param: Option<u64>) {
    next(input);
    ready();
    send(&ChildMessage::HostCall {
        seq: 1,
        method: "stream.play".into(),
        args: json!({
            "source": { "push": { "format": "pcm_s16le", "rate": 8000, "channels": 1 } },
            "title": "Tone",
        }),
    });
    let mut item = Value::Null;
    serve_with(input, |message| match message {
        HostMessage::HostResult { seq: 1, ok: true, result: Some(reply), .. } => {
            item = reply["item"].clone();
            send(&ChildMessage::HostCall {
                seq: 2,
                method: "stream.push".into(),
                args: json!({ "item": item, "data_b64": tone_b64() }),
            });
        }
        HostMessage::HostResult { seq: 2, .. } if param.is_some() => process::exit(CRASH_CODE),
        HostMessage::HostResult { seq: 2, .. } => send(&ChildMessage::HostCall {
            seq: 3,
            method: "stream.stop".into(),
            args: json!({ "item": item }),
        }),
        _ => {}
    });
}

/// Plays a URL through `stream.play` and, with a parameter, exits once it is accepted.
pub(super) fn pull(input: &mut BufReader<Stdin>, param: Option<u64>) {
    next(input);
    ready();
    send(&ChildMessage::HostCall {
        seq: 1,
        method: "stream.play".into(),
        args: json!({ "source": { "url": "https://radio.example.com/live" }, "title": "Radio" }),
    });
    serve_with(input, |message| {
        if matches!(message, HostMessage::HostResult { seq: 1, .. }) && param.is_some() {
            process::exit(CRASH_CODE);
        }
    });
}
