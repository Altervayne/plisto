/*
 * Process tests for what passes between a native plugin's page, its child and the plugin API: relayed
 * page calls, the child's host calls, page events, the page state and sidebar clicks. Every child is
 * the test binary in one of the behaviors of `test_child.rs`; the host runs on a fake clock, so rate
 * buckets refill only when a test moves it.
 */

// -- Library Imports --
use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// -- Local Imports --
use super::child::SendError;
use super::link::RecordingLink;
use super::protocol::HostMessage;
use super::relay::RELAY_TIMEOUT;
use super::status::HostState;
use super::test_child::{CALLS_FILE, RESUME_FILE};
use super::tests::{eventually, Supervised};
use super::NativeHost;
use crate::plugins::api::error::{ApiCode, ApiError, PLUGIN_ERROR_MAX_CHARS};
use crate::plugins::api::host_event::{HostEvent, PageEvent};
use crate::plugins::api::ui_state::UiAnswer;
use crate::plugins::api::{self, HostContext, Kind};
use crate::plugins::paths::data_dir;
use crate::plugins::state::{BootView, Runtime};
use crate::plugins::test_kit::{ui, Kit, ID};
use crate::state::AppState;

/// A page frame's view of the app: its `plugin.*` calls go through the native host.
struct PageHost(NativeHost);

impl HostContext for PageHost {
    fn setting(&self, _: &str) -> Option<String> {
        None
    }

    fn os_prefers_dark(&self) -> bool {
        false
    }

    fn emit(&self, _: HostEvent) {}

    fn main_window_shown(&self) -> bool {
        true
    }

    fn app_state(&self) -> Option<&AppState> {
        None
    }

    fn relay_call(&self, id: &str, method: &str, args: Value) -> Result<Value, ApiError> {
        self.0.relay(id, method, args)
    }
}

impl Supervised {
    /// Relays waiting for the current run's child.
    fn open_relays(&self) -> usize {
        let children = self.host.children.lock().unwrap();
        children.get(ID).map_or(0, |run| run.relays.open_count())
    }

    /// Page events the current run dropped.
    fn page_events_dropped(&self) -> u32 {
        let children = self.host.children.lock().unwrap();
        children.get(ID).map_or(0, |run| {
            run.stats.page_events_dropped.load(Ordering::Relaxed)
        })
    }

    /// `host_result` frames the current run's outbox had no room for.
    fn results_dropped(&self) -> u32 {
        let children = self.host.children.lock().unwrap();
        children
            .get(ID)
            .map_or(0, |run| run.stats.results_dropped.load(Ordering::Relaxed))
    }

    /// Every `host_result` the child received, in order.
    fn host_results(&self) -> Vec<Value> {
        self.stderr()
            .lines()
            .filter_map(|line| line.strip_prefix("host_result="))
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }

    /// The `host_result` frames for `seq`, once there are `count` of them.
    fn results_for(&self, seq: u64, count: usize) -> Vec<Value> {
        let of_seq = || -> Vec<Value> {
            let all = self.host_results();
            all.into_iter().filter(|r| r["seq"] == seq).collect()
        };
        assert!(eventually(|| of_seq().len() >= count), "{}", self.stderr());
        of_seq()
    }

    fn result_for(&self, seq: u64) -> Value {
        self.results_for(seq, 1).remove(0)
    }

    /// Writes the frames `host-calls` sends, then lets it send them.
    fn send_frames(&self, frames: Value) {
        let data = data_dir(&self.k.data, ID);
        fs::write(data.join(CALLS_FILE), frames.to_string()).unwrap();
        fs::write(data.join(RESUME_FILE), b"").unwrap();
    }

    fn page_events(&self) -> Vec<PageEvent> {
        let events = self.link.api_events();
        events
            .into_iter()
            .filter_map(|event| match event {
                HostEvent::Page(page) => Some(page),
                _ => None,
            })
            .collect()
    }

    fn running(mode: &str, caps: &[&str]) -> Supervised {
        let s = Supervised::granted(mode, caps);
        s.start();
        assert!(s.reaches(HostState::Running));
        s
    }
}

fn host_call(seq: u64, method: &str, args: Value) -> Value {
    json!({ "type": "host_call", "seq": seq, "method": method, "args": args })
}

fn code_of(result: &Value) -> &str {
    result["error"]["code"].as_str().unwrap_or("")
}

// ---- Relay ----

#[test]
fn a_page_call_reaches_the_child_without_its_prefix_and_comes_back() {
    let s = Supervised::running("echo", &[]);
    let page = PageHost(s.host.clone());
    let call = |method: &str, args: &str| {
        api::dispatch(
            &s.plugins.enabled_set(),
            s.plugins.api(),
            ID,
            method,
            args,
            Path::new("unused"),
            &page,
            Instant::now(),
        )
    };
    assert_eq!(call("plugin.method", "{}"), Ok(json!("method")));
    assert_eq!(
        call("plugin.echo", r#"{"a":[1,"x"]}"#),
        Ok(json!({ "a": [1, "x"] }))
    );
    let failed = call("plugin.fail", "{}").unwrap_err();
    assert_eq!(failed.code, ApiCode::PluginError);
    assert_eq!(failed.message, "e".repeat(PLUGIN_ERROR_MAX_CHARS));
    assert_eq!(s.open_relays(), 0);
}

#[test]
fn a_relay_the_child_never_answers_times_out_and_the_child_still_answers_the_next() {
    let s = Supervised::running("echo", &[]);
    let quick = NativeHost {
        relay_timeout: Duration::from_millis(200),
        ..s.host.clone()
    };
    assert_eq!(
        quick.relay(ID, "silent", json!({})),
        Err(ApiError::timeout())
    );
    assert_eq!(s.open_relays(), 0);
    assert_eq!(
        s.host.relay(ID, "echo", json!({ "n": 1 })),
        Ok(json!({ "n": 1 }))
    );
    assert_eq!(s.host.status(ID).unwrap().protocol_errors, 0);
}

#[test]
fn a_crash_fails_every_open_relay_at_once() {
    let s = Supervised::running("echo", &[]);
    let host = s.host.clone();
    let waiting = thread::spawn(move || {
        let started = Instant::now();
        (host.relay(ID, "silent", json!({})), started.elapsed())
    });
    assert!(eventually(|| s.open_relays() == 1));
    // The child exits on this one: it is failed too, never left to its timeout.
    assert_eq!(
        s.host.relay(ID, "exit", json!({})),
        Err(ApiError::unavailable())
    );
    let (result, waited) = waiting.join().unwrap();
    assert_eq!(result, Err(ApiError::unavailable()));
    assert!(waited < RELAY_TIMEOUT);
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert_eq!(
        s.host.relay(ID, "echo", json!({})),
        Err(ApiError::unavailable())
    );
}

#[test]
fn a_stop_fails_every_open_relay_at_once() {
    let s = Supervised::running("echo", &[]);
    let host = s.host.clone();
    let waiting = thread::spawn(move || host.relay(ID, "silent", json!({})));
    assert!(eventually(|| s.open_relays() == 1));
    s.host.stop_plugin(ID);
    assert_eq!(waiting.join().unwrap(), Err(ApiError::unavailable()));
}

#[test]
fn a_child_that_is_not_running_answers_no_relay_and_takes_no_click() {
    let s = Supervised::granted("echo", &[]);
    assert_eq!(
        s.host.relay(ID, "echo", json!({})),
        Err(ApiError::unavailable())
    );
    assert!(!s.host.deliver_sidebar(ID, "tg", Some(true), "g-1"));

    // Not responding: a relay is still sent and runs into its timeout, a click is refused.
    let s = Supervised::running("stall-until-file", &[]);
    for _ in 0..3 {
        s.tick_after(Duration::from_secs(1));
    }
    assert_eq!(s.state(), Some(HostState::NotResponding));
    assert!(!s.host.deliver_sidebar(ID, "tg", Some(true), "g-1"));
    let quick = NativeHost {
        relay_timeout: Duration::from_millis(100),
        ..s.host.clone()
    };
    assert_eq!(quick.relay(ID, "echo", json!({})), Err(ApiError::timeout()));
}

#[test]
fn a_full_outbox_refuses_a_relay_busy_and_a_click() {
    let s = Supervised::running("read-after-file", &[]);
    let (_, child) = s.host.ready_run(ID).unwrap();
    let big = HostMessage::Feed {
        event: json!("y".repeat(64 * 1024)),
        lost: 0,
    };
    let mut full = false;
    for _ in 0..10_000 {
        if child.send(&big) == Err(SendError::Full) {
            full = true;
            break;
        }
    }
    assert!(full);
    assert_eq!(s.host.relay(ID, "echo", json!({})), Err(ApiError::busy()));
    assert_eq!(s.open_relays(), 0);
    assert!(!s.host.deliver_sidebar(ID, "tg", Some(true), "g-1"));
    fs::write(data_dir(&s.k.data, ID).join(RESUME_FILE), b"").unwrap();
}

// ---- Host calls ----

#[test]
fn a_host_call_without_its_grant_is_denied() {
    let s = Supervised::running("host-call", &[]);
    let result = s.result_for(1);
    assert_eq!(result["ok"], false);
    assert_eq!(code_of(&result), "denied");
}

#[test]
fn a_child_reaches_neither_the_network_nor_the_relay_and_acts_only_as_itself() {
    let s = Supervised::running("host-calls", &["ui.toast"]);
    s.send_frames(json!([
        host_call(1, "net.fetch", json!({ "url": "https://example.com" })),
        host_call(2, "plugin.echo", json!({})),
        host_call(3, "app.info", json!({ "plugin_id": "com.example.other" })),
        host_call(4, "app.info", json!([])),
        host_call(5, "ui.toast", json!({ "text": "Hi" })),
        // The toast is still open, so this seq is in use.
        host_call(5, "app.info", json!({})),
        { "type": "result", "seq": 99, "ok": true },
    ]));
    assert_eq!(code_of(&s.result_for(1)), "unknown_method");
    assert_eq!(code_of(&s.result_for(2)), "unknown_method");
    let info = s.result_for(3);
    assert_eq!(info["result"]["plugin_id"], ID);
    assert_eq!(code_of(&s.result_for(4)), "invalid_args");
    assert_eq!(code_of(&s.result_for(5)), "invalid_args");
    assert!(eventually(
        || s.host.status(ID).unwrap().protocol_errors == 2
    ));

    // The open toast answers its own seq once it ends.
    let api = s.plugins.api();
    assert!(eventually(|| api.ui().pending_events().len() == 1));
    assert_eq!(api.ui().pending_events()[0].id, ID);
    api.ui().release(ID);
    let answers = s.results_for(5, 2);
    assert_eq!(answers[1]["result"], json!({ "result": "dismissed" }));
    assert_eq!(s.state(), Some(HostState::Running));
}

#[test]
fn a_child_shares_its_rate_buckets_with_its_frames() {
    let s = Supervised::running("host-calls", &[]);
    let (enabled, api) = (s.plugins.enabled_set(), s.plugins.api());
    let now = Instant::now();
    for _ in 0..10 {
        api::admit(&enabled, api, ID, "app.info", 2, now).unwrap();
    }
    s.send_frames(json!([host_call(1, "app.info", json!({}))]));
    let limited = s.result_for(1);
    assert_eq!(code_of(&limited), "rate_limited");
    assert!(limited["error"]["retry_after_ms"].as_u64().unwrap() > 0);
}

#[test]
fn a_child_shares_its_in_flight_slots_with_its_frames() {
    let s = Supervised::running("host-calls", &[]);
    let (enabled, api) = (s.plugins.enabled_set(), s.plugins.api());
    let now = Instant::now();
    let held: Vec<api::Admitted> = (0..16)
        .map(|_| api::admit(&enabled, api, ID, "log.write", 2, now).unwrap())
        .collect();
    s.send_frames(json!([host_call(1, "app.info", json!({}))]));
    assert_eq!(code_of(&s.result_for(1)), "busy");
    drop(held);
}

#[test]
fn a_host_call_flood_is_answered_or_counted_and_the_child_runs_on() {
    let s = Supervised::running("host-calls", &[]);
    let calls: Vec<Value> = (1..=200)
        .map(|seq| host_call(seq, "app.info", json!({})))
        .collect();
    s.send_frames(Value::Array(calls));
    assert!(eventually(|| {
        s.host_results().len() + s.results_dropped() as usize == 200
    }));
    let results = s.host_results();
    let answered = results.iter().filter(|r| r["ok"] == true).count();
    // The `ambient` bucket holds 10 and the clock does not move.
    assert!(answered <= 10);
    assert!(results
        .iter()
        .all(|r| r["ok"] == true || code_of(r) == "rate_limited"));
    assert_eq!(s.state(), Some(HostState::Running));
    assert_eq!(s.host.status(ID).unwrap().protocol_errors, 0);
}

#[test]
fn a_prompt_from_the_child_needs_its_page_or_the_gesture_of_a_click_once() {
    let s = Supervised::running("confirm-on-input", &["ui.confirm"]);
    let refused = s.result_for(1);
    assert_eq!(refused["error"]["reason"], "no_gesture");

    // `confirm` refills one token per 10 s; the fake clock gives it one for each prompt.
    s.clock.advance(Duration::from_secs(10));
    let api = s.plugins.api();
    let gesture = api.ui().mint(ID, Instant::now());
    assert!(s.host.deliver_sidebar(ID, "go", None, &gesture));
    assert!(eventually(|| api.ui().pending_events().len() == 1));
    let prompt = api.ui().pending_events().remove(0);
    assert_eq!(prompt.id, ID);
    s.clock.advance(Duration::from_secs(10));
    let answer = UiAnswer::Confirm { value: true };
    assert!(api
        .ui()
        .answer(&prompt.request_id, answer, true, Instant::now()));
    assert_eq!(s.result_for(2)["result"], json!({ "answer": true }));
    // The same gesture again: spent.
    let again = s.result_for(3);
    assert_eq!(again["error"]["reason"], "no_gesture");
    assert!(api.ui().pending_events().is_empty());
}

#[test]
fn a_disable_ends_the_childs_open_prompt_and_its_late_answer_harms_nothing() {
    let s = Supervised::running("host-calls", &["ui.toast"]);
    s.send_frames(json!([host_call(1, "ui.toast", json!({ "text": "Hi" }))]));
    let api = s.plugins.api();
    assert!(eventually(|| api.ui().pending_events().len() == 1));
    crate::plugins::lifecycle::disable(&s.k.data, &s.plugins, ID).unwrap();
    assert!(api.ui().pending_events().is_empty());
    assert_eq!(s.state(), Some(HostState::Off));
    assert!(!s.host.is_running(ID));
}

// ---- Page events and the page state ----

#[test]
fn page_events_are_dropped_while_the_page_is_closed() {
    let s = Supervised::running("page-events:200", &[]);
    assert!(eventually(|| s.page_events_dropped() >= 10));
    assert!(s.page_events().is_empty());
}

#[test]
fn page_events_pass_twenty_per_second_while_the_page_is_open() {
    let s = Supervised::granted("page-events:200", &[]);
    s.plugins.api().set_page_open(ID, true);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(eventually(|| s.page_events_dropped() >= 10));
    let events = s.page_events();
    assert_eq!(events.len(), 20);
    assert_eq!(
        (events[0].id.as_str(), events[0].topic.as_str()),
        (ID, "levels")
    );
    assert_eq!(events[0].data, json!({ "n": 0 }));
    // One second later the bucket holds twenty more.
    s.clock.advance(Duration::from_secs(1));
    assert!(eventually(|| s.page_events().len() == 40));
    let dropped = s.page_events_dropped();
    assert!(eventually(|| s.page_events_dropped() > dropped));
    assert_eq!(s.page_events().len(), 40);
}

#[test]
fn a_page_event_over_32_kib_is_dropped_and_a_bad_topic_is_a_protocol_error() {
    let s = Supervised::granted("page-event-sizes", &[]);
    s.plugins.api().set_page_open(ID, true);
    s.start();
    assert!(eventually(|| s.page_events().len() == 2));
    let events = s.page_events();
    assert_eq!(events[0].topic, "big");
    assert_eq!(events[0].data.as_str().unwrap().len(), 32_763);
    assert_eq!(events[1].topic, "done");
    assert_eq!(s.page_events_dropped(), 1);
    assert_eq!(s.host.status(ID).unwrap().protocol_errors, 1);
}

#[test]
fn the_child_hears_its_page_once_ready_and_on_every_change() {
    let s = Supervised::running("echo", &[]);
    assert!(
        s.logs(r#"page={"type":"page","open":false}"#),
        "{}",
        s.stderr()
    );
    s.plugins.api().set_page_open(ID, true);
    s.host.page_changed(&s.plugins, ID, true);
    assert!(
        s.logs(r#"page={"type":"page","open":true}"#),
        "{}",
        s.stderr()
    );

    // Shown before the child is ready, the page is sent once it is.
    let s = Supervised::granted("echo", &[]);
    s.plugins.api().set_page_open(ID, true);
    s.start();
    assert!(
        s.logs(r#"page={"type":"page","open":true}"#),
        "{}",
        s.stderr()
    );
}

#[test]
fn a_ui_page_frame_reads_as_starting_from_its_open_until_it_is_live() {
    let k = Kit::new();
    k.install(&ui("1.0.0", &[]));
    k.enable(&[]);
    let host = NativeHost::new(k.data.clone(), Arc::new(RecordingLink::default()));
    let state = || host.status(ID).map(|s| s.host);
    host.page_changed(&k.plugins, ID, true);
    assert_eq!(state(), Some(HostState::Starting));
    host.frame_event(&k.plugins, ID, "live", None);
    assert_eq!(state(), Some(HostState::Running));
    // A live frame stays live whatever the page does.
    host.page_changed(&k.plugins, ID, true);
    host.page_changed(&k.plugins, ID, false);
    assert_eq!(state(), Some(HostState::Running));
    host.frame_event(&k.plugins, ID, "detached", None);
    host.page_changed(&k.plugins, ID, true);
    assert_eq!(state(), Some(HostState::Starting));

    // A background frame has its own supervision.
    let k = Kit::new();
    k.install(&ui("1.0.0", &["background"]));
    k.enable(&["background"]);
    let host = NativeHost::new(k.data.clone(), Arc::new(RecordingLink::default()));
    host.page_changed(&k.plugins, ID, true);
    assert_eq!(host.status(ID), None);
}

// ---- Sidebar input ----

#[test]
fn a_click_reaches_a_running_child_and_not_a_stopped_one() {
    let s = Supervised::running("echo", &[]);
    assert!(s.host.deliver_sidebar(ID, "tg", Some(true), "g-1"));
    let want =
        r#"sidebar_input={"type":"sidebar_input","item_id":"tg","value":true,"gesture":"g-1"}"#;
    assert!(s.logs(want), "{}", s.stderr());
    assert!(s.host.deliver_sidebar(ID, "go", None, "g-2"));
    assert!(s.logs(r#""item_id":"go","value":null"#), "{}", s.stderr());
    s.host.stop_plugin(ID);
    assert!(!s.host.deliver_sidebar(ID, "tg", Some(false), "g-3"));
}

// ---- The end of a run ----

#[test]
fn a_stale_runs_host_calls_during_the_restart_grace_leave_nothing_behind() {
    let s = Supervised::running("calls-on-shutdown", &["ui.toast", "ui.chips"]);
    let old = s.host.children.lock().unwrap().get(ID).unwrap().clone();
    s.host.restart(&s.plugins, ID).unwrap();
    // The old pump has handled everything once the test holds the only handle on its run.
    assert!(eventually(|| Arc::strong_count(&old) == 1));
    assert!(s.reaches(HostState::Running));
    // Never admitted: no toast or chip was ever shown, and nothing is left open.
    assert!(s.link.api_events().is_empty());
    let api = s.plugins.api();
    assert!(api.ui().pending_events().is_empty());
    assert!(api.sidebar().snapshot(&s.plugins.enabled_set()).is_empty());
}

#[test]
fn the_page_stays_open_across_a_crash_restart_and_a_user_restart() {
    let s = Supervised::granted("page-events:50", &[]);
    s.plugins.api().set_page_open(ID, true);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(eventually(|| s.page_events().len() == 20));

    // Killed under its run: a crash.
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert!(s.plugins.api().is_page_open(ID));
    s.tick_after(Duration::from_secs(1));
    assert!(s.reaches(HostState::Running));
    // The log is truncated at each launch, so this is the new child's.
    assert!(
        s.logs(r#"page={"type":"page","open":true}"#),
        "{}",
        s.stderr()
    );
    // The second run spends the twenty tokens the restart delay refilled.
    assert!(eventually(|| s.page_events().len() == 40));

    s.host.restart(&s.plugins, ID).unwrap();
    assert!(s.reaches(HostState::Running));
    assert!(
        s.logs(r#"page={"type":"page","open":true}"#),
        "{}",
        s.stderr()
    );
    // A new run does not refill the plugin's bucket: the third run's events are dropped until the
    // clock refills it.
    assert!(eventually(|| s.page_events_dropped() >= 10));
    assert_eq!(s.page_events().len(), 40);
    s.clock.advance(Duration::from_secs(1));
    assert!(eventually(|| s.page_events().len() == 60));
}

#[test]
fn the_end_of_a_run_keeps_the_pages_network_work_and_a_disable_ends_it() {
    let s = Supervised::running("echo", &[]);
    let api = s.plugins.api();
    let fired = Arc::new(Mutex::new(Vec::new()));
    let sink = fired.clone();
    let _fetch = api
        .net()
        .open(
            ID,
            Kind::Fetch,
            None,
            Box::new(move |why| sink.lock().unwrap().push(why)),
        )
        .unwrap();
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    s.host.restart(&s.plugins, ID).unwrap();
    assert!(s.reaches(HostState::Running));
    assert!(fired.lock().unwrap().is_empty());
    assert_eq!(api.net().running(ID, Kind::Fetch), 1);

    crate::plugins::lifecycle::disable(&s.k.data, &s.plugins, ID).unwrap();
    assert_eq!(api.net().running(ID, Kind::Fetch), 0);
    assert_eq!(fired.lock().unwrap().len(), 1);
}

#[test]
fn exit_and_safe_mode_fail_every_open_relay() {
    for safe in [false, true] {
        let s = Supervised::running("echo", &[]);
        let host = s.host.clone();
        let waiting = thread::spawn(move || host.relay(ID, "silent", json!({})));
        assert!(eventually(|| s.open_relays() == 1));
        if safe {
            s.host.on_runtime_safe(BootView {
                runtime: Runtime::Safe,
                unclean: false,
                safe_flag: false,
            });
        } else {
            s.host.begin_exit();
            s.host.shutdown_all();
        }
        assert_eq!(
            waiting.join().unwrap(),
            Err(ApiError::unavailable()),
            "{safe}"
        );
    }
}
