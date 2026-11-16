/*
 * Process tests for app events reaching a native child: its subscribe through `host_call`, what it
 * hears, a full outbox, and the end of its subscription with its run.
 */

// -- Library Imports --
use std::fs;
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

// -- Local Imports --
use super::child::SendError;
use super::protocol::HostMessage;
use super::status::HostState;
use super::test_child::RESUME_FILE;
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

    assert_eq!(s.host.deliver_event(ID, "theme", &theme("dark")), ChildDelivery::Sent);
    assert!(eventually(|| !s.logged("event").is_empty()), "{}", s.stderr());
    assert_eq!(
        s.logged("event")[0],
        json!({ "type": "event", "topic": "theme", "data": { "theme": "dark" } })
    );
}

#[test]
fn an_event_reaches_only_a_running_child() {
    let s = Supervised::granted("events", &[]);
    assert_eq!(s.host.deliver_event(ID, "theme", &theme("dark")), ChildDelivery::NotRunning);
    s.start();
    assert!(s.reaches(HostState::Running));
    let other = "com.example.elsewhere";
    assert_eq!(s.host.deliver_event(other, "theme", &theme("dark")), ChildDelivery::NotRunning);
    s.host.ready_run(ID).unwrap().1.kill();
    assert!(s.reaches(HostState::Restarting { retry_in_ms: 1000 }));
    assert_eq!(s.host.deliver_event(ID, "theme", &theme("dark")), ChildDelivery::NotRunning);
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

    assert_eq!(s.host.deliver_event(ID, "theme", &theme("dark")), ChildDelivery::Full);
    assert_eq!(run.stats.stream_dropped.load(Ordering::Relaxed), 0);

    // Once the child reads again the same call is taken, and it hears that one event only.
    fs::write(data_dir(&s.k.data, ID).join(RESUME_FILE), b"").unwrap();
    assert!(eventually(|| s.host.deliver_event(ID, "theme", &theme("light")) == ChildDelivery::Sent));
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
