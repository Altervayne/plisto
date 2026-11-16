/*
 * Process tests for app events reaching a native child: its subscribe through `host_call`, what it
 * hears, a full outbox, the hold while a subscribe is answered, the sequence mark that makes an event
 * produced before the answer stale, and the end of its subscription with its run.
 */

// -- Library Imports --
use std::collections::BTreeSet;
use std::fs;
use std::sync::atomic::Ordering;
use std::time::Instant;

use serde_json::{json, Value};

// -- Local Imports --
use super::child::SendError;
use super::protocol::HostMessage;
use super::status::HostState;
use super::test_child::{CALLS_FILE, RESUME_FILE};
use super::tests::{eventually, Supervised};
use crate::plugins::api::events::{ChildDelivery, Side, Topic};
use crate::plugins::paths::data_dir;
use crate::plugins::test_kit::ID;

impl Supervised {
    fn child_topics(&self) -> Vec<Topic> {
        self.plugins.api().events().topics_of(ID, Side::Child)
    }

    /// Every line the child logged as `<name>=<json>`, parsed, in order.
    fn logged(&self, name: &str) -> Vec<Value> {
        let prefix = format!("{name}=");
        self.stderr()
            .lines()
            .filter_map(|line| line.strip_prefix(&prefix))
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }

    /// The sequence number of a delivery the hub produces now, for another plugin's frame.
    fn produced(&self) -> u64 {
        let events = self.plugins.api().events();
        let other = "com.example.elsewhere";
        events.drop_side(other, Side::Frame);
        events.replace(other, Side::Frame, &BTreeSet::from([Topic::Locale]), &[]);
        events.offer(Topic::Locale, Instant::now(), &|_| json!({ "locale": "en" }))[0].seq
    }

    fn deliver(&self, value: &str, seq: u64) -> ChildDelivery {
        self.host.deliver_event(ID, "theme", &theme(value), seq)
    }

    /// A delivery produced now, handed to the child.
    fn deliver_new(&self, value: &str) -> ChildDelivery {
        self.deliver(value, self.produced())
    }
}

fn theme(value: &str) -> Value {
    json!({ "theme": value })
}

#[test]
fn a_child_subscribes_through_host_call() {
    let s = Supervised::granted("events", &[]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(eventually(|| !s.child_topics().is_empty()), "{}", s.stderr());
    assert_eq!(s.child_topics(), [Topic::Theme, Topic::Locale]);
    assert!(s.plugins.api().events().topics_of(ID, Side::Frame).is_empty());
    assert!(eventually(|| !s.logged("host_result").is_empty()));
    let reply = &s.logged("host_result")[0];
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["result"]["topics"], json!(["locale", "theme"]));
    // The mark stays with the run; the child's answer never carries it.
    assert!(reply["result"].get("mark").is_none(), "{reply}");

    assert_eq!(s.deliver_new("dark"), ChildDelivery::Sent);
    assert!(eventually(|| !s.logged("event").is_empty()), "{}", s.stderr());
    assert_eq!(
        s.logged("event")[0],
        json!({ "type": "event", "topic": "theme", "data": { "theme": "dark" } })
    );
}

#[test]
fn an_event_reaches_only_a_running_child() {
    let s = Supervised::granted("events", &[]);
    assert_eq!(s.deliver_new("dark"), ChildDelivery::NotRunning);
    s.start();
    assert!(s.reaches(HostState::Running));
    let other = "com.example.elsewhere";
    let seq = s.produced();
    assert_eq!(
        s.host.deliver_event(other, "theme", &theme("dark"), seq),
        ChildDelivery::NotRunning
    );
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert_eq!(s.deliver_new("dark"), ChildDelivery::NotRunning);
    assert!(s.logged("event").is_empty());
}

#[test]
fn a_full_outbox_answers_full_and_drops_nothing() {
    let s = Supervised::granted("read-after-file", &[]);
    s.start();
    assert!(s.reaches(HostState::Running));
    let (run, child) = s.host.ready_run(ID).unwrap();
    let big = HostMessage::Feed {
        event: json!("y".repeat(64 * 1024)),
        lost: 0,
    };
    let mut filled = 0;
    let mut full = false;
    for _ in 0..10_000 {
        if child.send(&big) == Err(SendError::Full) {
            full = true;
            break;
        }
        filled += 1;
    }
    assert!(full);

    assert_eq!(s.deliver_new("dark"), ChildDelivery::Full);
    assert_eq!(run.stats.stream_dropped.load(Ordering::Relaxed), 0);

    // Once the child reads again the same call is taken, and it hears that one event only.
    fs::write(data_dir(&s.k.data, ID).join(RESUME_FILE), b"").unwrap();
    assert!(eventually(|| s.deliver_new("light") == ChildDelivery::Sent));
    assert!(eventually(|| !s.logged("event").is_empty()), "{filled}");
    assert_eq!(s.logged("event").len(), 1);
    assert_eq!(s.logged("event")[0]["data"], theme("light"));
}

#[test]
fn a_restarted_child_has_no_subscription() {
    let s = Supervised::granted("events", &[]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(eventually(|| !s.child_topics().is_empty()), "{}", s.stderr());

    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert!(s.child_topics().is_empty());
}

/// A child in `host-calls` mode, running, whose run's subscribes queue behind a job that waits until
/// the returned sender fires. `subscribe_args` is sent as one `events.subscribe` once released.
fn subscribe_held(subscribe_args: Value) -> (Supervised, tokio::sync::oneshot::Sender<()>) {
    let s = Supervised::granted("host-calls", &[]);
    s.start();
    assert!(s.reaches(HostState::Running));
    let (run, _) = s.host.ready_run(ID).unwrap();
    let (open, wait) = tokio::sync::oneshot::channel::<()>();
    run.serial_calls.queue(Box::pin(async move {
        let _ = wait.await;
    }));
    let call = json!([{ "type": "host_call", "seq": 1, "method": "events.subscribe", "args": subscribe_args }]);
    let data = data_dir(&s.k.data, ID);
    fs::write(data.join(CALLS_FILE), call.to_string()).unwrap();
    fs::write(data.join(RESUME_FILE), b"").unwrap();
    assert!(
        eventually(|| run.event_gate_state().0 == 1),
        "{}",
        s.stderr()
    );
    (s, open)
}

#[test]
fn an_event_offered_during_a_subscribe_arrives_after_its_answer() {
    let (s, open) = subscribe_held(json!({ "topics": ["theme"] }));
    assert_eq!(s.deliver_new("dark"), ChildDelivery::Full);
    assert!(s.logged("event").is_empty());
    open.send(()).unwrap();
    assert!(eventually(|| s.deliver_new("dark") == ChildDelivery::Sent));
    assert!(eventually(|| !s.logged("event").is_empty()), "{}", s.stderr());
    let log = s.stderr();
    let answered = log.find("host_result=").unwrap();
    let heard = log.find("event=").unwrap();
    assert!(answered < heard, "{log}");
    assert_eq!(s.logged("host_result")[0]["ok"], true);
}

#[test]
fn an_event_produced_before_the_answer_is_stale_after_it() {
    let (s, open) = subscribe_held(json!({ "topics": ["theme"] }));
    // Produced before the subscribe reads `current` and seeds: older than what the answer carries.
    let before = s.produced();
    open.send(()).unwrap();
    assert!(eventually(|| !s.logged("host_result").is_empty()), "{}", s.stderr());
    let (run, _) = s.host.ready_run(ID).unwrap();
    let mark = s.plugins.api().events().mark_of(ID, Side::Child);
    assert!(before <= mark);
    assert_eq!(run.event_gate_state(), (0, mark));
    // Whether it was held as full and retried, or sent late, it never reaches the child.
    assert_eq!(s.deliver("light", before), ChildDelivery::Stale);
    assert_eq!(s.deliver_new("dark"), ChildDelivery::Sent);
    assert!(eventually(|| !s.logged("event").is_empty()), "{}", s.stderr());
    assert_eq!(s.logged("event").len(), 1);
    assert_eq!(s.logged("event")[0]["data"], theme("dark"));
}

#[test]
fn the_hold_lifts_when_the_subscribe_is_refused() {
    let (s, open) = subscribe_held(json!({ "topics": "theme" }));
    assert_eq!(s.deliver_new("dark"), ChildDelivery::Full);
    open.send(()).unwrap();
    assert!(eventually(|| !s.logged("host_result").is_empty()), "{}", s.stderr());
    assert_eq!(s.logged("host_result")[0]["ok"], false);
    // A refused subscribe sets no mark.
    let (run, _) = s.host.ready_run(ID).unwrap();
    assert_eq!(run.event_gate_state(), (0, 0));
    assert!(eventually(|| s.deliver_new("dark") == ChildDelivery::Sent));
}

#[test]
fn the_hold_ends_with_the_run() {
    let (s, open) = subscribe_held(json!({ "topics": ["theme"] }));
    let (run, child) = s.host.ready_run(ID).unwrap();
    child.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    // The ended run still holds its subscribe until that call finishes, unanswered.
    assert_eq!(run.event_gate_state().0, 1);
    open.send(()).unwrap();
    assert!(eventually(|| run.event_gate_state().0 == 0));
    assert!(s.logged("host_result").is_empty());
    // The run's end cleared the child side before the subscribe set it; the subscribe undoes it, so
    // a restarted program hears nothing it did not ask for.
    assert!(eventually(|| s.child_topics().is_empty()), "{:?}", s.child_topics());
    assert_eq!(s.plugins.api().events().mask(), 0);
}

#[test]
fn two_subscribes_from_one_child_apply_in_the_order_sent() {
    let s = Supervised::granted("events-order", &[]);
    s.start();
    assert!(s.reaches(HostState::Running));
    assert!(eventually(|| s.logged("host_result").len() == 3), "{}", s.stderr());
    assert_eq!(s.child_topics(), [Topic::AppMode]);
    let seqs: Vec<_> = s.logged("host_result").iter().map(|r| r["seq"].clone()).collect();
    assert_eq!(seqs, [json!(1), json!(2), json!(3)]);
}
