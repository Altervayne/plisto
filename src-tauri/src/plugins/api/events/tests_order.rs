// -- Library Imports --
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// -- Local Imports --
use super::coalesce::GAP;
use super::subs::{Delivery, EventSubs};
use super::tests_hub::Bench;
use super::{Input, Side, Topic};
use crate::plugins::api::app::SETTING_THEME;
use crate::plugins::api::host_event::HostEvent;
use crate::plugins::api::test_rig::ID;

const OTHER: &str = "com.example.other";

fn theme(name: &str) -> Value {
    json!({ "theme": name })
}

fn themes() -> BTreeSet<Topic> {
    [Topic::Theme].into()
}

fn one(mut sent: Vec<Delivery>) -> Delivery {
    assert_eq!(sent.len(), 1, "{sent:?}");
    sent.remove(0)
}

#[test]
fn a_change_back_after_a_resubscribe_inside_one_gap_still_goes_out() {
    let events = EventSubs::default();
    let t0 = Instant::now();
    let soon = t0 + Duration::from_millis(10);
    events.replace(ID, Side::Frame, &themes(), &[]);
    let dark = one(events.offer(Topic::Theme, t0, &|_| theme("dark")));
    assert!(events
        .offer(Topic::Theme, soon, &|_| theme("light"))
        .is_empty());
    // The re-subscribe answers light; the dark already sent is under its mark.
    let mark = events.replace(
        ID,
        Side::Frame,
        &themes(),
        &[(Topic::Theme, theme("light"))],
    );
    assert!(dark.seq <= mark);
    assert_eq!(events.next_due(), None);
    // The user picks dark again: it differs from the answer and goes out above the mark.
    let again = one(events.offer(Topic::Theme, t0 + GAP, &|_| theme("dark")));
    assert_eq!(again.data, theme("dark"));
    assert!(again.seq > mark);
}

#[test]
fn the_mark_rises_with_each_replace_and_covers_every_earlier_delivery() {
    let events = EventSubs::default();
    let t0 = Instant::now();
    let opened = events.replace(ID, Side::Frame, &themes(), &[]);
    let first = one(events.offer(Topic::Theme, t0, &|_| theme("dark")));
    assert!(first.seq > opened);
    // Dropped, then subscribed again: the new lane's mark still covers the old delivery.
    let cleared = events.replace(ID, Side::Frame, &BTreeSet::new(), &[]);
    let again = events.replace(ID, Side::Frame, &themes(), &[(Topic::Theme, theme("dark"))]);
    assert!(first.seq < cleared && cleared < again);
    assert_eq!(events.mark_of(ID, Side::Frame), again);
    let later = one(events.offer(Topic::Theme, t0 + GAP, &|_| theme("light")));
    assert!(later.seq > again);
    // Each side has its own mark.
    assert_eq!(events.mark_of(ID, Side::Child), 0);
}

#[test]
fn a_deferred_delivery_at_or_under_the_mark_is_dropped() {
    let events = EventSubs::default();
    let t0 = Instant::now();
    events.replace(ID, Side::Child, &themes(), &[]);
    // Produced before the subscribe's seed, refused as full while it was answered.
    let held = one(events.offer(Topic::Theme, t0, &|_| theme("dark")));
    events.replace(
        ID,
        Side::Child,
        &themes(),
        &[(Topic::Theme, theme("light"))],
    );
    events.defer(held, t0);
    assert_eq!(events.next_due(), None);
    assert!(events.due(t0 + GAP * 4).is_empty());
    // One produced after the seed is kept and retried, with a new number.
    let newer = one(events.offer(Topic::Theme, t0 + GAP, &|_| theme("dark")));
    let first = newer.seq;
    events.defer(newer, t0 + GAP);
    let retried = one(events.due(t0 + GAP * 2));
    assert_eq!(retried.data, theme("dark"));
    assert!(retried.seq > first);
}

#[test]
fn seq_strictly_increases_across_plugins_and_sides() {
    let events = EventSubs::default();
    let t0 = Instant::now();
    for (id, side) in [
        (ID, Side::Frame),
        (ID, Side::Child),
        (OTHER, Side::Frame),
        (OTHER, Side::Child),
    ] {
        events.replace(id, side, &themes(), &[]);
    }
    let mut seqs = Vec::new();
    for step in 0..3u32 {
        let at = t0 + GAP * (2 * step);
        let leading = theme(&format!("lead {step}"));
        let sent = events.offer(Topic::Theme, at, &|_| leading.clone());
        assert_eq!(sent.len(), 4);
        seqs.extend(sent.iter().map(|d| d.seq));
        // A value inside the gap goes out from `due`, numbered when it leaves.
        let trailing = theme(&format!("trail {step}"));
        let inside = events.offer(Topic::Theme, at + GAP / 2, &|_| trailing.clone());
        assert!(inside.is_empty());
        seqs.extend(events.due(at + GAP).iter().map(|d| d.seq));
    }
    assert_eq!(seqs.len(), 24);
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "{seqs:?}");
}

#[test]
fn a_frame_event_carries_its_seq_and_the_subscribe_answers_its_mark() {
    let mut bench = Bench::new(&[]);
    let first = bench.subscribe(json!(["theme"]));
    let first_mark = first["mark"].as_u64().unwrap();
    bench
        .rig
        .host
        .settings
        .insert(SETTING_THEME.into(), "dark".into());
    bench.handle(Input::Ambient);
    let emitted: Vec<u64> = bench
        .rig
        .host
        .events
        .lock()
        .unwrap()
        .drain(..)
        .filter_map(|event| match event {
            HostEvent::Topic(event) => Some(event.seq),
            _ => None,
        })
        .collect();
    assert_eq!(emitted.len(), 1);
    assert!(emitted[0] > first_mark);
    // The re-subscribe's mark covers the event already emitted, so the window drops it if it
    // arrives after the answer, and is the side's mark from then on.
    let second = bench.subscribe(json!(["theme"]));
    let second_mark = second["mark"].as_u64().unwrap();
    assert!(second_mark > emitted[0]);
    let events = bench.rig.plugins.api().events();
    assert_eq!(events.mark_of(ID, Side::Frame), second_mark);
}

#[test]
fn a_topic_left_out_of_current_goes_out_again_above_the_mark() {
    let events = EventSubs::default();
    let t0 = Instant::now();
    events.replace(ID, Side::Frame, &themes(), &[]);
    let sent = one(events.offer(Topic::Theme, t0, &|_| theme("dark")));
    // The re-subscribe could not read the theme, so it answered nothing for it; the event sent
    // before is under the mark and the receiver drops it.
    let mark = events.replace(ID, Side::Frame, &themes(), &[]);
    assert!(sent.seq < mark);
    // The refresh reads the same value: it goes out again, above the mark.
    let again = one(events.offer(Topic::Theme, t0 + GAP, &|_| theme("dark")));
    assert_eq!(again.data, theme("dark"));
    assert!(again.seq > mark);

    // The same for `playback_state`, whose counters do not stop the value read again.
    let state = json!({ "transport": "playing", "start_seq": 4, "seek_seq": 1 });
    let playback: BTreeSet<Topic> = [Topic::PlaybackState].into();
    events.replace(ID, Side::Child, &playback, &[]);
    one(events.offer(Topic::PlaybackState, t0, &|_| state.clone()));
    let mark = events.replace(ID, Side::Child, &playback, &[]);
    let again = one(events.offer(Topic::PlaybackState, t0 + GAP, &|_| state.clone()));
    assert!(again.seq > mark);
}
