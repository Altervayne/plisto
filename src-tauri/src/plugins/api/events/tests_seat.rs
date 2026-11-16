// -- Library Imports --
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// -- Local Imports --
use super::compose::LibraryChange;
use super::subs::EventSubs;
use super::tests_hub::{reader, Bench};
use super::{Input, Side, Topic};
use crate::audio::{StreamPhase, StreamStatus};
use crate::plugins::api::app::SETTING_THEME;
use crate::plugins::api::test_rig::{insert_track, ID};

fn now_playing_sent(sent: &[(String, Value)]) -> Vec<Value> {
    sent.iter()
        .filter(|(topic, _)| topic == "now_playing")
        .map(|(_, data)| data.clone())
        .collect()
}

#[test]
fn two_opened_files_in_a_row_each_fire_now_playing() {
    let mut bench = reader();
    bench.status(|s| s.track_id = Some(-4));
    bench.subscribe(json!(["now_playing"]));
    let file = json!({ "source": "file", "track_id": null, "track": null, "stream": null });
    for next in [-5, -6] {
        bench.status(|s| {
            s.track_id = Some(next);
            s.start_seq += 1;
        });
        bench.handle(Input::Status);
        assert_eq!(
            now_playing_sent(&bench.sent()),
            vec![file.clone()],
            "{next}"
        );
    }
}

#[test]
fn two_same_titled_streams_in_a_row_each_fire_now_playing() {
    let mut bench = reader();
    let seated = |item: i64, bench: &super::tests_hub::Bench| {
        bench.status(|s| {
            s.track_id = Some(item);
            s.stream = Some(StreamStatus {
                live: true,
                seekable: false,
                phase: StreamPhase::Playing,
                parked: None,
                parked_cleared: false,
            });
        });
    };
    seated(-10, &bench);
    bench.subscribe(json!(["now_playing"]));
    seated(-11, &bench);
    bench.handle(Input::Status);
    let sent = now_playing_sent(&bench.sent());
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["source"], "stream");
    // Nothing names the item.
    assert!(!sent[0].to_string().contains("11"), "{}", sent[0]);
    seated(-12, &bench);
    bench.handle(Input::Status);
    assert_eq!(now_playing_sent(&bench.sent()).len(), 1);
}

#[test]
fn a_row_edit_fires_now_playing_once_and_a_pause_or_tick_never() {
    let mut bench = reader();
    let id = insert_track(&bench.rig.conn(), "C:\\Music\\a.flac", "First", "A");
    bench.status(|s| {
        s.track_id = Some(id);
        s.playing = true;
    });
    bench.subscribe(json!(["now_playing"]));

    bench.status(|s| s.playing = false);
    bench.handle(Input::Status);
    bench.status(|s| s.position_secs = 30.0);
    bench.handle(Input::Status);
    assert!(bench.sent().is_empty());

    bench
        .rig
        .conn()
        .execute(
            "UPDATE tracks SET raw_title = 'Renamed' WHERE id = ?1",
            [id],
        )
        .unwrap();
    let edited = || {
        Input::Library(LibraryChange {
            track_ids: Some(vec![id]),
            ..LibraryChange::default()
        })
    };
    bench.handle(edited());
    let sent = now_playing_sent(&bench.sent());
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["track"]["title"], "Renamed");
    // The same report again changes nothing.
    bench.handle(edited());
    bench.handle(Input::Status);
    assert!(bench.sent().is_empty());
}

#[test]
fn now_playing_compares_the_seated_item_and_the_payload() {
    let events = EventSubs::default();
    let topics: BTreeSet<Topic> = [Topic::NowPlaying].into();
    let stream = |title: &str| {
        json!({ "source": "stream", "track_id": null, "track": null,
                "stream": { "title": title, "artist": null, "live": true, "mine": false } })
    };
    events.replace_seated(
        ID,
        Side::Frame,
        &topics,
        &[(Topic::NowPlaying, stream("A"))],
        Some(-3),
    );
    let t0 = Instant::now();
    let at = |s: u64| t0 + Duration::from_secs(s);
    let offer = |s, item, title: &str| {
        let value = stream(title);
        events.offer_seated(Topic::NowPlaying, at(s), Some(item), &|_| value.clone())
    };
    // The answered value with the answered item: nothing.
    assert!(offer(1, -3, "A").is_empty());
    // A title change of the same item fires, and so does a new item with an equal payload.
    assert_eq!(offer(2, -3, "B").len(), 1);
    assert_eq!(offer(3, -4, "B").len(), 1);
    assert!(offer(4, -4, "B").is_empty());
    // Other topics ignore the item.
    let theme: BTreeSet<Topic> = [Topic::Theme].into();
    events.replace(
        ID,
        Side::Frame,
        &theme,
        &[(Topic::Theme, json!({ "theme": "dark" }))],
    );
    let dark = json!({ "theme": "dark" });
    let theme_at = |item| events.offer_seated(Topic::Theme, at(5), item, &|_| dark.clone());
    assert!(theme_at(Some(-9)).is_empty());
}

#[test]
fn a_value_offered_after_the_seed_and_deferred_is_replaced_by_the_refresh() {
    let events = EventSubs::default();
    let topics: BTreeSet<Topic> = [Topic::Theme].into();
    let t0 = Instant::now();
    let theme = |name: &str| json!({ "theme": name });
    // The hub read "light" before the reply read "dark" but offers it after the lane was seeded, so
    // it is numbered above the mark; the child is held, so the value is deferred.
    events.replace(ID, Side::Child, &topics, &[(Topic::Theme, theme("dark"))]);
    let old = events.offer(Topic::Theme, t0, &|_| theme("light"));
    assert_eq!(old.len(), 1);
    events.defer(old.into_iter().next().unwrap(), t0);
    // The refresh the reply queued reads again: the newer value replaces the deferred one.
    assert!(events
        .offer(Topic::Theme, t0 + Duration::from_millis(10), &|_| theme(
            "dark"
        ))
        .is_empty());
    let due = events.due(t0 + super::coalesce::GAP);
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].data, theme("dark"));
}

#[test]
fn a_first_subscribe_seeds_and_sends_nothing_equal_to_current() {
    let mut bench = Bench::new(&[]);
    bench.subscribe(json!(["theme"]));
    bench.handle(Input::Refresh(Topic::Theme.bit()));
    assert!(bench.sent().is_empty());
    // Cleared and subscribed again, the topic is new: seeded again.
    bench
        .rig
        .host
        .settings
        .insert(SETTING_THEME.into(), "dark".into());
    bench.handle(Input::Ambient);
    assert_eq!(bench.sent().len(), 1);
    bench.subscribe(json!([]));
    bench
        .rig
        .host
        .settings
        .insert(SETTING_THEME.into(), "light".into());
    bench.subscribe(json!(["theme"]));
    bench.handle(Input::Refresh(Topic::Theme.bit()));
    assert!(bench.sent().is_empty());
}

fn theme(name: &str) -> Value {
    json!({ "theme": name })
}
