/*
 * The test child's event behaviors: both subscribe through `events.subscribe` once they are ready, and
 * `serve_with` logs every `event` the host sends and every `host_result`.
 */

// -- Library Imports --
use std::io::{BufReader, Stdin};

use serde_json::json;

// -- Local Imports --
use super::{next, ready, send, serve};
use crate::plugins::native::protocol::ChildMessage;

fn subscribe(seq: u64, topics: &[&str]) {
    send(&ChildMessage::HostCall {
        seq,
        method: "events.subscribe".into(),
        args: json!({ "topics": topics }),
    });
}

/// Subscribes to `theme` and `locale`.
pub(super) fn subscribed(input: &mut BufReader<Stdin>) {
    next(input);
    ready();
    subscribe(1, &["theme", "locale"]);
    serve(input);
}

/// Sends three subscribes without waiting for an answer; the last one names `app_mode` alone.
pub(super) fn in_order(input: &mut BufReader<Stdin>) {
    next(input);
    ready();
    subscribe(1, &["theme", "locale", "app_mode"]);
    subscribe(2, &["locale"]);
    subscribe(3, &["app_mode"]);
    serve(input);
}
