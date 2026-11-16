// -- Library Imports --
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// -- Local Imports --
use super::{Side, Topic};
use crate::audio::RepeatMode;
use crate::plugins::api::app::SETTING_LOCALE;
use crate::plugins::api::error::{ApiCode, ApiError};
use crate::plugins::api::test_rig::{insert_track, Rig, ID};
use crate::plugins::api::{admit_from, run, test_ctx, Caller, FakeHost};
use crate::plugins::manifest::{Capability, Tier};
use crate::plugins::state::{EnabledSet, Serving};

fn reader() -> Rig {
    Rig::new(&[Capability::PlaybackRead, Capability::LibraryRead])
}

fn subscribe(rig: &Rig, topics: Value) -> Result<Value, ApiError> {
    rig.call("events.subscribe", json!({ "topics": topics }))
}

/// `events.subscribe` from the plugin's child, at `at` seconds past now.
fn child_subscribe(rig: &Rig, topics: Value, at: u64) -> Result<Value, ApiError> {
    let args = json!({ "topics": topics }).to_string();
    let now = Instant::now() + Duration::from_secs(at);
    let enabled = rig.plugins.enabled_set();
    let api = rig.plugins.api();
    let admitted = admit_from(
        Caller::Child,
        &enabled,
        api,
        ID,
        "events.subscribe",
        args.len(),
        now,
    )?;
    run(&admitted, &args, Path::new("unused"), &rig.host, api)
}

fn topics(rig: &Rig, side: Side) -> Vec<Topic> {
    rig.plugins.api().events().topics_of(ID, side)
}

#[test]
fn subscribe_replaces_the_callers_side_only() {
    let rig = reader();
    let events = rig.plugins.api().events();
    let child: BTreeSet<Topic> = [Topic::Locale, Topic::LibraryChanged].into();
    subscribe(&rig, json!(["theme", "queue"])).unwrap();
    events.replace(ID, Side::Child, &child, &[]);
    assert_eq!(topics(&rig, Side::Frame), [Topic::Queue, Topic::Theme]);
    assert_eq!(
        topics(&rig, Side::Child),
        [Topic::LibraryChanged, Topic::Locale]
    );

    // A frame's call replaces the frame side and leaves the child's.
    subscribe(&rig, json!(["now_playing"])).unwrap();
    assert_eq!(topics(&rig, Side::Frame), [Topic::NowPlaying]);
    assert_eq!(
        topics(&rig, Side::Child),
        [Topic::LibraryChanged, Topic::Locale]
    );
    // An empty set clears its side alone.
    events.replace(ID, Side::Child, &BTreeSet::new(), &[]);
    assert!(topics(&rig, Side::Child).is_empty());
    assert_eq!(topics(&rig, Side::Frame), [Topic::NowPlaying]);
    subscribe(&rig, json!([])).unwrap();
    assert_eq!(events.mask(), 0);
}

#[test]
fn a_child_subscribe_is_refused_and_sets_nothing() {
    let rig = reader();
    subscribe(&rig, json!(["theme"])).unwrap();
    let refused = child_subscribe(&rig, json!(["locale"]), 1).unwrap_err();
    assert_eq!(refused.code, ApiCode::Unavailable);
    assert!(topics(&rig, Side::Child).is_empty());
    assert_eq!(topics(&rig, Side::Frame), [Topic::Theme]);
    assert_eq!(rig.plugins.api().events().mask(), Topic::Theme.bit());
}

/// A serving entry like the rig's own, with `version` and `granted`.
fn serving(version: &str, granted: Vec<Capability>) -> Serving {
    Serving {
        tier: Tier::Ui,
        version: version.into(),
        granted,
        origins: Vec::new().into(),
        dev_mode: false,
    }
}

#[test]
fn a_subscribe_whose_plugin_changed_during_the_call_keeps_nothing() {
    let host = FakeHost::default();
    let grants = vec![Capability::PlaybackRead];
    let args = json!({ "topics": ["theme", "queue"] });
    let args = args.as_object().unwrap();
    for during in [
        EnabledSet::default(),
        EnabledSet::only(ID, serving("2.0.0", grants.clone())),
        EnabledSet::only(ID, serving("1.0.0", Vec::new())),
    ] {
        let mut call = test_ctx(Path::new("unused"), &host);
        call.serving = serving("1.0.0", grants.clone());
        call.enabled = during;
        let ctx = call.ctx();
        // The frame's earlier set is undone too: the side is cleared.
        let earlier: BTreeSet<Topic> = [Topic::Locale].into();
        call.api.events().replace(ID, Side::Frame, &earlier, &[]);
        let refused = super::subscribe(&ctx, args).done().unwrap_err();
        assert_eq!(refused.code, ApiCode::Unavailable);
        assert!(call.api.events().topics_of(ID, Side::Frame).is_empty());
        assert_eq!(call.api.events().mask(), 0);
    }
    // Unchanged, the same call is answered.
    let mut call = test_ctx(Path::new("unused"), &host);
    call.serving = serving("1.0.0", grants.clone());
    call.enabled = EnabledSet::only(ID, serving("1.0.0", grants));
    assert!(super::subscribe(&call.ctx(), args).done().is_ok());
}

#[test]
fn a_topic_that_cannot_be_read_is_left_out_of_current() {
    let mut rig = reader();
    rig.host.unreadable = true;
    let reply = subscribe(&rig, json!(["theme", "locale", "app_mode", "queue"])).unwrap();
    assert_eq!(
        reply["topics"],
        json!(["app_mode", "locale", "queue", "theme"])
    );
    let current = reply["current"].as_object().unwrap();
    assert_eq!(current.keys().collect::<Vec<_>>(), ["queue"]);

    // A playing track whose row cannot be read leaves `now_playing` out.
    let rig = reader();
    let id = insert_track(&rig.conn(), "C:\\Music\\a.flac", "T", "A");
    rig.state().player_status.lock().unwrap().track_id = Some(id);
    rig.conn()
        .execute_batch("ALTER TABLE tracks RENAME TO tracks_moved")
        .unwrap();
    let reply = subscribe(&rig, json!(["now_playing", "playback_state"])).unwrap();
    let current = reply["current"].as_object().unwrap();
    assert_eq!(current.keys().collect::<Vec<_>>(), ["playback_state"]);
    assert_eq!(
        topics(&rig, Side::Frame),
        [Topic::NowPlaying, Topic::PlaybackState]
    );
}

#[test]
fn subscribe_returns_current_values() {
    let mut rig = reader();
    rig.host.settings.insert(SETTING_LOCALE.into(), "fr".into());
    rig.host.dark = true;
    {
        let mut status = rig.state().player_status.lock().unwrap();
        status.track_id = Some(-3);
        status.playing = true;
        status.position_secs = 7.5;
        status.duration_secs = 90.0;
        status.repeat = RepeatMode::One;
        status.queue_index = 2;
        status.queue_len = 5;
        status.start_seq = 4;
        status.seek_seq = 1;
    }
    let all = json!([
        "theme",
        "library_changed",
        "queue",
        "locale",
        "app_mode",
        "now_playing",
        "playback_state",
        "theme"
    ]);
    let reply = subscribe(&rig, all).unwrap();
    assert_eq!(
        reply["topics"],
        json!([
            "app_mode",
            "library_changed",
            "locale",
            "now_playing",
            "playback_state",
            "queue",
            "theme"
        ])
    );
    let current = reply["current"].as_object().unwrap();
    // Every state topic, and no value for the edge topic.
    assert_eq!(current.len(), 6);
    assert!(current.get("library_changed").is_none());
    assert_eq!(current["theme"], json!({ "theme": "dark" }));
    assert_eq!(current["locale"], json!({ "locale": "fr" }));
    assert_eq!(current["app_mode"], json!({ "app_mode": "both" }));
    assert_eq!(
        current["now_playing"],
        json!({ "source": "file", "track_id": null, "track": null, "stream": null })
    );
    assert_eq!(
        current["queue"],
        json!({ "index": 2, "length": 5, "rev": 0, "parked": false })
    );
    let state = &current["playback_state"];
    assert_eq!(state["transport"], "playing");
    assert_eq!(state["position_secs"], 7.5);
    assert_eq!(state["duration_secs"], 90.0);
    assert_eq!(state["repeat"], "one");
    assert_eq!(
        (state["start_seq"].clone(), state["seek_seq"].clone()),
        (json!(4), json!(1))
    );
    assert!(state["position_at"].as_i64().unwrap() > 0);
    assert_eq!(state["stream"], Value::Null);
}

#[test]
fn unknown_reserved_and_over_16_topics_are_invalid() {
    let rig = reader();
    subscribe(&rig, json!(["theme"])).unwrap();
    let seventeen: Vec<&str> = std::iter::repeat_n("theme", 17).collect();
    let bad = [
        json!({}),
        json!({ "topics": "theme" }),
        json!({ "topics": null }),
        json!({ "topics": [1] }),
        json!({ "topics": ["theme", "nope"] }),
        json!({ "topics": ["Theme"] }),
        json!({ "topics": ["stream"] }),
        json!({ "topics": ["theme", "stream"] }),
        json!({ "topics": seventeen }),
    ];
    for args in bad {
        let error = rig.call("events.subscribe", args.clone()).unwrap_err();
        assert_eq!(error.code, ApiCode::InvalidArgs, "{args}");
    }
    // A refused call changes nothing.
    assert_eq!(topics(&rig, Side::Frame), [Topic::Theme]);
    // Sixteen names are taken, duplicates folded.
    let sixteen: Vec<&str> = std::iter::repeat_n("locale", 16).collect();
    let reply = subscribe(&rig, json!(sixteen)).unwrap();
    assert_eq!(reply["topics"], json!(["locale"]));
}

#[test]
fn a_topic_without_its_grant_is_denied_and_keeps_the_old_set() {
    let rig = Rig::new(&[Capability::PlaybackRead]);
    subscribe(&rig, json!(["theme", "queue"])).unwrap();
    let error = subscribe(&rig, json!(["locale", "library_changed"])).unwrap_err();
    assert_eq!(error.code, ApiCode::Denied);
    assert!(
        error.message.contains("library_changed"),
        "{}",
        error.message
    );
    assert!(error.message.contains("library.read"), "{}", error.message);
    assert_eq!(topics(&rig, Side::Frame), [Topic::Queue, Topic::Theme]);

    let ambient_only = Rig::new(&[]);
    for topic in ["now_playing", "playback_state", "queue"] {
        let error = subscribe(&ambient_only, json!([topic])).unwrap_err();
        assert_eq!(error.code, ApiCode::Denied, "{topic}");
    }
    let reply = subscribe(&ambient_only, json!(["theme", "locale", "app_mode"])).unwrap();
    assert_eq!(reply["topics"], json!(["app_mode", "locale", "theme"]));
}

#[test]
fn a_plugin_that_is_not_serving_cannot_subscribe() {
    let rig = reader();
    let off = crate::plugins::state::EnabledSet::default();
    let now = Instant::now();
    let refused = admit_from(
        Caller::Frame,
        &off,
        rig.plugins.api(),
        ID,
        "events.subscribe",
        2,
        now,
    );
    assert_eq!(refused.err().map(|e| e.code), Some(ApiCode::Unavailable));
    assert_eq!(rig.plugins.api().events().mask(), 0);
}
