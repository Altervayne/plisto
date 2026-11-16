/*
 * Runs the built executable the way Plisto does: argv, piped stdin and stdout, frames by hand. The
 * frames are written out here rather than through the program's protocol module, so these tests also
 * check the wire format itself.
 */

#[path = "../src/test_ring.rs"]
mod test_ring;

// -- Library Imports --
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use test_ring::TestRing;

const WAIT: Duration = Duration::from_secs(10);

struct Plugin {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<Value>,
}

impl Plugin {
    fn start(tap: &str, extra: &[&str]) -> Self {
        let data: PathBuf = std::env::temp_dir().join("tap-meter-process-test");
        let mut child = Command::new(env!("CARGO_BIN_EXE_tap-meter"))
            .args(["--plisto-protocol", "1", "--plisto-data"])
            .arg(&data)
            .args(["--plisto-tap", tap])
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("starts tap-meter");
        let stdin = child.stdin.take();
        let mut out = BufReader::new(child.stdout.take().expect("piped stdout"));
        let (tx, frames) = mpsc::channel();
        thread::spawn(move || loop {
            let mut len = String::new();
            if out.read_line(&mut len).unwrap_or(0) == 0 {
                return;
            }
            let mut body = vec![0u8; len.trim().parse().expect("a decimal length")];
            out.read_exact(&mut body).expect("a whole body");
            let mut newline = [0u8];
            out.read_exact(&mut newline).expect("the trailing newline");
            assert_eq!(newline, *b"\n");
            if tx
                .send(serde_json::from_slice(&body).expect("JSON"))
                .is_err()
            {
                return;
            }
        });
        Self {
            child,
            stdin,
            frames,
        }
    }

    fn send(&mut self, message: Value) {
        let body = message.to_string();
        let stdin = self.stdin.as_mut().expect("stdin is open");
        write!(stdin, "{}\n{}\n", body.len(), body).expect("writes a frame");
        stdin.flush().expect("flushes");
    }

    fn hello(&mut self) {
        self.send(json!({
            "type": "hello", "protocol": 1, "api_version": 1, "plisto_version": "2.7.0",
            "id": "dev.plisto.tapmeter", "granted": ["audio.tap", "audio.events"]
        }));
        let ready = self.next("ready");
        assert_eq!(ready["protocol"], 1);
    }

    // The next message of `kind`, skipping others; fails after `WAIT`.
    fn next(&self, kind: &str) -> Value {
        self.next_within(kind, WAIT).expect("the message arrives")
    }

    fn next_within(&self, kind: &str, within: Duration) -> Option<Value> {
        let end = Instant::now() + within;
        loop {
            match self
                .frames
                .recv_timeout(end.saturating_duration_since(Instant::now()))
            {
                Ok(m) if m["type"] == kind => return Some(m),
                Ok(_) => {}
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return None,
            }
        }
    }

    // The next `host_call` other than the status item's updates, which the reporter sends on its own
    // schedule, and the event subscription every run makes after `ready`.
    fn next_call(&self) -> Value {
        loop {
            let call = self.next("host_call");
            if call["args"]["item_id"] != "state" && call["method"] != "events.subscribe" {
                return call;
            }
        }
    }

    // The run's `events.subscribe` call.
    fn subscribe_call(&self) -> Value {
        loop {
            let call = self.next("host_call");
            if call["method"] == "events.subscribe" {
                return call;
            }
        }
    }

    // The next `log` whose text contains `part`.
    fn next_log(&self, part: &str) -> Value {
        loop {
            let line = self.next("log");
            if line["text"].as_str().is_some_and(|t| t.contains(part)) {
                return line;
            }
        }
    }

    fn exit(&mut self) -> ExitStatus {
        let end = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait().expect("polls the child") {
                return status;
            }
            assert!(Instant::now() < end, "the process did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn hello_ping_shutdown() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    p.send(json!({"type": "ping", "seq": 7}));
    assert_eq!(p.next("pong")["seq"], 7);
    p.send(json!({"type": "shutdown"}));
    assert_eq!(p.exit().code(), Some(0));
}

#[test]
fn the_end_of_input_ends_the_process() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    p.stdin = None;
    assert_eq!(p.exit().code(), Some(0));
}

#[test]
fn a_page_call_is_answered_and_an_unknown_one_fails() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    p.send(json!({"type": "call", "seq": 5, "method": "ping", "args": {}}));
    let result = p.next("result");
    assert_eq!(result["seq"], 5);
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"]["pong"], true);
    p.send(json!({"type": "call", "seq": 6, "method": "nope", "args": {}}));
    let result = p.next("result");
    assert_eq!(result["seq"], 6);
    assert_eq!(result["ok"], false);
    assert!(result["error"]["message"].is_string());
}

#[test]
fn levels_go_to_the_page_only_while_it_is_open() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    p.send(json!({"type": "page", "open": false}));
    assert!(p
        .next_within("page_event", Duration::from_millis(400))
        .is_none());
    p.send(json!({"type": "page", "open": true}));
    let event = p.next("page_event");
    assert_eq!(event["topic"], "levels");
    assert!(event["data"]["peak_db"].is_array());
    p.send(json!({"type": "page", "open": false}));
    // Anything already written drains; then nothing more comes.
    thread::sleep(Duration::from_millis(200));
    while p.frames.try_recv().is_ok() {}
    assert!(p
        .next_within("page_event", Duration::from_millis(400))
        .is_none());
}

#[test]
fn a_toggle_click_is_confirmed_through_the_sidebar() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    // The first host call of a run sets the toggle's starting state.
    let first = p.next_call();
    assert_eq!(first["method"], "ui.sidebar.update");
    assert_eq!(first["args"]["state"]["on"], false);
    p.send(json!({"type": "sidebar_input", "item_id": "mirror", "value": true, "gesture": "g"}));
    let confirm = p.next_call();
    assert_eq!(confirm["method"], "ui.sidebar.update");
    assert_eq!(
        confirm["args"],
        json!({"item_id": "mirror", "state": {"on": true}})
    );
    assert_eq!(p.next_call()["method"], "ui.chips");
}

#[test]
fn the_action_asks_with_its_gesture_and_unprompted_asks_without() {
    let mut p = Plugin::start("none", &["--prompt-unprompted"]);
    p.hello();
    p.next_call();
    // The state Plisto sends after `ready` asks nothing; closing the open page does.
    p.send(json!({"type": "page", "open": false}));
    p.send(json!({"type": "page", "open": true}));
    p.send(json!({"type": "page", "open": false}));
    let unprompted = p.next_call();
    assert_eq!(unprompted["method"], "ui.confirm");
    assert!(unprompted["args"].get("gesture").is_none());
    p.send(json!({
        "type": "host_result", "seq": unprompted["seq"], "ok": false,
        "error": {"code": "denied", "message": "No gesture.", "reason": "no_gesture"}
    }));
    let refused = p.next_log("refused");
    assert_eq!(refused["level"], "warn");
    assert!(refused["text"]
        .as_str()
        .unwrap()
        .ends_with("denied (no_gesture)"));

    p.send(json!({"type": "sidebar_input", "item_id": "prompt", "value": null, "gesture": "g-9"}));
    let asked = p.next_call();
    assert_eq!(asked["method"], "ui.confirm");
    assert_eq!(asked["args"]["gesture"], "g-9");
}

#[test]
fn the_run_subscribes_after_ready_and_logs_the_events_it_gets() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    let call = p.subscribe_call();
    assert_eq!(call["args"], json!({"topics": ["playback_state", "locale"]}));
    p.send(json!({
        "type": "host_result", "seq": call["seq"], "ok": true,
        "result": {"topics": ["locale", "playback_state"], "current": {"locale": {"locale": "en"}}}
    }));
    p.next_log("subscribed to locale, playback_state");
    p.next_log("current locale: en");
    p.send(json!({
        "type": "event", "topic": "playback_state",
        "data": {"transport": "playing", "start_seq": 2, "seek_seq": 0}
    }));
    assert_eq!(
        p.next_log("event playback_state")["text"],
        "event playback_state: playing, start 2, seek 0"
    );
    p.send(json!({"type": "event", "topic": "locale", "data": {"locale": "fr"}}));
    p.next_log("event locale: fr");
}

#[test]
fn levels_follow_the_tap_and_the_feed() {
    let mut ring = TestRing::create();
    ring.record(1, 48_000, 2);
    ring.publish();
    let mut p = Plugin::start(ring.name(), &[]);
    p.hello();
    // The first status says the tap is open and silent.
    let first = p.next("status");
    assert_eq!(first["state"], "idle", "{first}");
    assert_eq!(first["text"], "silent", "{first}");
    p.send(json!({"type": "feed", "lost": 0, "event": {"seq": 1, "cause": "start", "transport": "playing"}}));

    // A constant 0.5 on both channels is -6.0 dBFS.
    let end = Instant::now() + WAIT;
    loop {
        for _ in 0..480 * 2 {
            ring.push(0.5);
        }
        ring.publish();
        if let Some(m) = p.next_within("status", Duration::from_millis(20)) {
            if m["state"] == "on" && m["text"] == "peak -6.0 -6.0 dB" {
                break;
            }
        }
        assert!(Instant::now() < end, "no level reached the status line");
    }
    p.send(json!({"type": "shutdown"}));
    assert_eq!(p.exit().code(), Some(0));
}

#[test]
fn a_missing_tap_is_a_warning_in_the_closed_vocabulary() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    let status = p.next("status");
    assert_eq!(status["state"], "warn", "{status}");
    assert_eq!(status["text"], "no tap", "{status}");
}

#[test]
fn unknown_messages_and_fields_do_not_end_the_process() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    p.send(json!({"type": "teleport", "x": 1}));
    p.send(json!({"type": "page", "open": true, "since": 3}));
    p.send(json!({"type": "sidebar_input", "item_id": "a", "value": null, "gesture": "g"}));
    p.send(json!({"type": "takeover_state", "held": false, "reason": "stopped"}));
    p.send(json!({"type": "ping", "seq": 4, "future": [1]}));
    assert_eq!(p.next("pong")["seq"], 4);
}

#[test]
fn a_status_is_sent_only_when_it_changes() {
    let mut p = Plugin::start("none", &[]);
    p.hello();
    p.next("status");
    assert!(p
        .next_within("status", Duration::from_millis(1500))
        .is_none());
}

#[test]
fn a_stall_silences_pongs_then_recovers() {
    let mut p = Plugin::start("none", &["--stall", "1"]);
    p.hello();
    p.send(json!({"type": "ping", "seq": 1}));
    assert_eq!(p.next("pong")["seq"], 1);

    p.send(json!({"type": "ping", "seq": 2}));
    assert!(p.next_within("pong", Duration::from_millis(600)).is_none());
    thread::sleep(Duration::from_millis(700));
    p.send(json!({"type": "ping", "seq": 3}));
    assert_eq!(p.next("pong")["seq"], 3);
}

#[test]
fn takeover_is_requested_at_start_and_released_at_exit_while_held() {
    let mut p = Plugin::start("none", &["--takeover"]);
    p.hello();
    assert_eq!(p.next("takeover")["hold"], true);
    p.send(json!({"type": "takeover_state", "held": true, "reason": "granted"}));
    // A status already on its way may still say otherwise; the next change says the output is held.
    loop {
        let status = p.next("status");
        if status["text"] == "holding output; no tap" {
            break;
        }
    }
    p.send(json!({"type": "shutdown"}));
    assert_eq!(p.next("takeover")["hold"], false);
    assert_eq!(p.exit().code(), Some(0));
}

#[test]
fn a_revoked_takeover_is_not_asked_for_again_or_released() {
    let mut p = Plugin::start("none", &["--takeover"]);
    p.hello();
    assert_eq!(p.next("takeover")["hold"], true);
    p.send(json!({"type": "takeover_state", "held": true, "reason": "granted"}));
    p.send(json!({"type": "takeover_state", "held": false, "reason": "not_responding"}));
    // Plisto repeats a release for silence after the next valid pong.
    p.send(json!({"type": "ping", "seq": 1}));
    assert_eq!(p.next("pong")["seq"], 1);
    p.send(json!({"type": "takeover_state", "held": false, "reason": "not_responding"}));
    assert_eq!(p.next_log("again: no change")["level"], "debug");
    p.send(json!({"type": "shutdown"}));
    assert!(p
        .next_within("takeover", Duration::from_millis(500))
        .is_none());
    assert_eq!(p.exit().code(), Some(0));
}

#[test]
fn crash_after_exits_with_a_failure_code() {
    let mut p = Plugin::start("none", &["--crash-after", "0.3"]);
    p.hello();
    assert_eq!(p.exit().code(), Some(3));
}
