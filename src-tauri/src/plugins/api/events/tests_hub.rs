// -- Library Imports --
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// -- Local Imports --
use super::compose::{now_playing, LibraryChange};
use super::hub::{Env, EventHub};
use super::{Input, Side, Topic};
use crate::audio::{PlayerStatus, StreamPhase, StreamStatus};
use crate::plugins::api::app::{SETTING_APP_MODE, SETTING_THEME};
use crate::plugins::api::host_event::HostEvent;
use crate::plugins::api::stream::{NowState, Skip, StreamNow};
use crate::plugins::api::test_rig::{insert_track, mark_gone, Rig, ID};
use crate::plugins::manifest::{Capability, Tier};
use crate::plugins::state::{EnabledSet, Serving};

/// A hub over a rig, driven with a clock that moves a second per input so no lane holds a value back.
pub(super) struct Bench {
    pub rig: Rig,
    pub hub: EventHub,
    t0: Instant,
    step: u64,
}

impl Bench {
    pub fn new(granted: &[Capability]) -> Bench {
        Bench {
            rig: Rig::new(granted),
            hub: EventHub::default(),
            t0: Instant::now(),
            step: 0,
        }
    }

    pub fn subscribe(&self, topics: Value) -> Value {
        self.rig
            .call("events.subscribe", json!({ "topics": topics }))
            .unwrap()
    }

    pub fn handle_with(&mut self, enabled: &EnabledSet, input: Input) {
        self.step += 1;
        let env = Env {
            api: self.rig.plugins.api(),
            enabled,
            host: &self.rig.host,
        };
        let at = self.t0 + Duration::from_secs(self.step);
        self.hub.handle(&env, input, at, 1_000 * self.step as i64);
    }

    pub fn handle(&mut self, input: Input) {
        let enabled = self.rig.plugins.enabled_set();
        self.handle_with(&enabled, input);
    }

    pub fn status(&self, change: impl FnOnce(&mut PlayerStatus)) {
        change(&mut self.rig.state().player_status.lock().unwrap());
    }

    /// The topic events sent so far, drained.
    pub fn sent(&self) -> Vec<(String, Value)> {
        self.rig
            .host
            .events
            .lock()
            .unwrap()
            .drain(..)
            .filter_map(|event| match event {
                HostEvent::Topic(event) => {
                    assert_eq!(event.id, ID);
                    Some((event.topic, event.data))
                }
                _ => None,
            })
            .collect()
    }
}

pub(super) fn reader() -> Bench {
    Bench::new(&[Capability::PlaybackRead, Capability::LibraryRead])
}

#[test]
fn position_ticks_fire_nothing() {
    let mut bench = reader();
    bench.status(|s| {
        s.track_id = Some(5);
        s.playing = true;
    });
    bench.subscribe(json!(["playback_state", "now_playing", "queue"]));
    for tick in 1..20 {
        bench.status(|s| s.position_secs = f64::from(tick) * 0.5);
        bench.handle(Input::Status);
    }
    assert!(bench.sent().is_empty());
}

#[test]
fn pause_seek_and_skip_fire_playback_state() {
    let mut bench = reader();
    bench.status(|s| {
        s.track_id = Some(5);
        s.playing = true;
        s.queue_len = 2;
    });
    bench.subscribe(json!(["playback_state"]));
    let one = |bench: &mut Bench| {
        bench.handle(Input::Status);
        let mut sent = bench.sent();
        assert_eq!(sent.len(), 1, "{sent:?}");
        let (topic, data) = sent.remove(0);
        assert_eq!(topic, "playback_state");
        data
    };

    bench.status(|s| {
        s.playing = false;
        s.position_secs = 10.0;
    });
    let paused = one(&mut bench);
    assert_eq!(paused["transport"], "paused");
    assert_eq!(paused["position_secs"], 10.0);
    assert_eq!(paused["position_at"], 1_000);

    bench.status(|s| {
        s.seek_seq += 1;
        s.position_secs = 42.0;
    });
    let sought = one(&mut bench);
    assert_eq!(
        (sought["seek_seq"].clone(), sought["position_secs"].clone()),
        (json!(1), json!(42.0))
    );

    bench.status(|s| {
        s.track_id = Some(6);
        s.start_seq += 1;
        s.playing = true;
        s.position_secs = 0.0;
        s.queue_index = 1;
    });
    let skipped = one(&mut bench);
    assert_eq!(
        (skipped["transport"].clone(), skipped["start_seq"].clone()),
        (json!("playing"), json!(1))
    );

    // Nothing else changed: nothing goes out.
    bench.handle(Input::Status);
    assert!(bench.sent().is_empty());
}

#[test]
fn now_playing_for_library_file_stream_and_gone() {
    let mut bench = reader();
    let (a, b) = {
        let conn = bench.rig.conn();
        (
            insert_track(&conn, "C:\\Music\\a.flac", "First", "A"),
            insert_track(&conn, "C:\\Music\\b.flac", "Second", "B"),
        )
    };
    bench.status(|s| s.track_id = Some(a));
    let reply = bench.subscribe(json!(["now_playing", "library_changed"]));
    let current = &reply["current"]["now_playing"];
    assert_eq!(
        (current["source"].clone(), current["track_id"].clone()),
        (json!("library"), json!(a))
    );
    assert_eq!(current["track"]["title"], "First");

    bench.status(|s| s.track_id = Some(b));
    bench.handle(Input::Status);
    let sent = bench.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1["track"]["title"], "Second");

    // A gone track keeps its id and loses its row, once the library reports it.
    mark_gone(&bench.rig.conn(), b);
    bench.handle(Input::Status);
    assert!(bench.sent().is_empty());
    bench.handle(Input::Library(LibraryChange {
        track_ids: Some(vec![b]),
        ..LibraryChange::default()
    }));
    let sent = bench.sent();
    assert_eq!(sent.len(), 2, "{sent:?}");
    let gone = &sent
        .iter()
        .find(|(topic, _)| topic == "now_playing")
        .unwrap()
        .1;
    assert_eq!(
        *gone,
        json!({ "source": "library", "track_id": b, "track": null, "stream": null })
    );

    // A file played off disk is not described.
    bench.status(|s| s.track_id = Some(-4));
    bench.handle(Input::Status);
    let sent = bench.sent();
    assert_eq!(
        sent[0].1,
        json!({ "source": "file", "track_id": null, "track": null, "stream": null })
    );

    // A stream: the title and artist, and whether it is the caller's own.
    let status = PlayerStatus {
        track_id: Some(-8),
        stream: Some(StreamStatus {
            live: false,
            seekable: true,
            phase: StreamPhase::Playing,
            parked: None,
            parked_cleared: false,
        }),
        ..PlayerStatus::default()
    };
    let now = StreamNow {
        item: -8,
        plugin_id: ID.into(),
        plugin_name: "Demo".into(),
        title: "Live set".into(),
        artist: None,
        album: None,
        now: None,
        live: false,
        seekable: true,
        duration_secs: Some(600.0),
        state: NowState::Playing,
        skip: Skip::default(),
        art_rev: 0,
        rev: 1,
    };
    assert_eq!(
        now_playing(&status, Some(&now), None).render(ID),
        json!({ "source": "stream", "track_id": null, "track": null,
                "stream": { "title": "Live set", "artist": null, "live": false, "mine": true } })
    );

    // Nothing seated.
    bench.status(|s| s.track_id = None);
    bench.handle(Input::Status);
    assert_eq!(
        bench.sent()[0].1,
        json!({ "source": null, "track_id": null, "track": null, "stream": null })
    );
}

#[test]
fn queue_rev_bumps_on_player_queue() {
    let mut bench = reader();
    bench.status(|s| s.queue_len = 3);
    let reply = bench.subscribe(json!(["queue"]));
    let rev = reply["current"]["queue"]["rev"].as_u64().unwrap();

    bench.handle(Input::Queue);
    let sent = bench.sent();
    assert_eq!(
        sent,
        [(
            "queue".to_string(),
            json!({ "index": 0, "length": 3, "rev": rev + 1, "parked": false })
        )]
    );
    // The index or length moving fires too, with the same revision.
    bench.status(|s| s.queue_index = 2);
    bench.handle(Input::Status);
    assert_eq!(bench.sent()[0].1["rev"], rev + 1);
    // A seated stream parks the queue.
    bench.status(|s| {
        s.track_id = Some(-1);
        s.stream = Some(StreamStatus {
            live: true,
            seekable: false,
            phase: StreamPhase::Buffering,
            parked: None,
            parked_cleared: false,
        });
    });
    bench.handle(Input::Status);
    assert_eq!(bench.sent()[0].1["parked"], true);
}

#[test]
fn settings_writes_fire_ambient_topics() {
    let mut bench = Bench::new(&[]);
    bench.subscribe(json!(["theme", "locale", "app_mode"]));
    bench.handle(Input::Ambient);
    assert!(bench.sent().is_empty());

    bench
        .rig
        .host
        .settings
        .insert(SETTING_THEME.into(), "dark".into());
    bench
        .rig
        .host
        .settings
        .insert(SETTING_APP_MODE.into(), "player".into());
    bench.handle(Input::Ambient);
    let mut sent = bench.sent();
    sent.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        sent,
        [
            ("app_mode".to_string(), json!({ "app_mode": "player" })),
            ("theme".to_string(), json!({ "theme": "dark" })),
        ]
    );
    // The same write again fires nothing.
    bench.handle(Input::Ambient);
    assert!(bench.sent().is_empty());
    // The OS theme counts for a user following the system.
    bench
        .rig
        .host
        .settings
        .insert(SETTING_THEME.into(), "system".into());
    bench.rig.host.dark = false;
    bench.handle(Input::Ambient);
    assert_eq!(
        bench.sent(),
        [("theme".to_string(), json!({ "theme": "light" }))]
    );
}

#[test]
fn library_changes_merge_inside_a_window_and_all_land() {
    let mut bench = reader();
    bench.subscribe(json!(["library_changed"]));
    let enabled = bench.rig.plugins.enabled_set();
    let env = Env {
        api: bench.rig.plugins.api(),
        enabled: &enabled,
        host: &bench.rig.host,
    };
    let t0 = Instant::now();
    let change = |ids: Vec<i64>, albums| {
        Input::Library(LibraryChange {
            track_ids: Some(ids),
            albums,
            playlists: false,
        })
    };
    bench.hub.handle(&env, change(vec![2], false), t0, 0);
    bench.hub.handle(
        &env,
        change(vec![1], true),
        t0 + Duration::from_millis(10),
        0,
    );
    bench.hub.handle(
        &env,
        change(vec![2], false),
        t0 + Duration::from_millis(20),
        0,
    );
    bench.hub.flush(&env, t0 + Duration::from_millis(100));
    assert_eq!(bench.sent().len(), 1);
    assert_eq!(
        bench.rig.plugins.api().events().next_due(),
        Some(t0 + Duration::from_millis(250))
    );
    bench.hub.flush(&env, t0 + Duration::from_millis(250));
    assert_eq!(
        bench.sent(),
        [(
            "library_changed".to_string(),
            json!({ "track_ids": [1, 2], "albums": true, "playlists": false })
        )]
    );
}

#[test]
fn delivery_rechecks_serving_and_grant() {
    let mut bench = reader();
    bench.subscribe(json!(["playback_state", "theme"]));
    let events = bench.rig.plugins.api().events();
    assert_eq!(
        events.topics_of(ID, Side::Frame),
        [Topic::PlaybackState, Topic::Theme]
    );

    // Serving without the playback grant: the topic is dropped at delivery, nothing is sent.
    let serving = Serving {
        tier: Tier::Ui,
        version: "1.0.0".into(),
        granted: Vec::new(),
        origins: Vec::new().into(),
        dev_mode: false,
    };
    let narrowed = EnabledSet::only(ID, serving);
    bench.status(|s| s.track_id = Some(1));
    bench.handle_with(&narrowed, Input::Status);
    assert!(bench.sent().is_empty());
    let events = bench.rig.plugins.api().events();
    assert_eq!(events.topics_of(ID, Side::Frame), [Topic::Theme]);

    // Not serving at all: the whole subscription goes.
    bench
        .rig
        .host
        .settings
        .insert(SETTING_THEME.into(), "dark".into());
    bench.handle_with(&EnabledSet::default(), Input::Ambient);
    assert!(bench.sent().is_empty());
    let events = bench.rig.plugins.api().events();
    assert!(events.topics_of(ID, Side::Frame).is_empty());
    assert_eq!(events.mask(), 0);
}

#[test]
fn an_idle_hub_composes_nothing() {
    let mut bench = reader();
    let id = insert_track(&bench.rig.conn(), "C:\\Music\\a.flac", "T", "A");
    bench.status(|s| {
        s.track_id = Some(id);
        s.playing = true;
    });
    for input in [
        Input::Status,
        Input::Queue,
        Input::Stream,
        Input::Ambient,
        Input::Library(LibraryChange::default()),
    ] {
        bench.handle(input);
    }
    assert!(bench.sent().is_empty());
    assert!(!bench.hub.holds_a_track());
    // Only the topics listened to are composed.
    bench.subscribe(json!(["theme"]));
    bench.handle(Input::Status);
    assert!(!bench.hub.holds_a_track());
}
