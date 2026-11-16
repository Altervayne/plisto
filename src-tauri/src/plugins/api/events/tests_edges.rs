// -- Library Imports --
use std::time::{Duration, Instant};

use serde_json::json;

// -- Local Imports --
use super::coalesce::GAP;
use super::hub::Env;
use super::tests_hub::{reader, Bench};
use super::{Input, Side, Topic};
use crate::plugins::api::app::SETTING_THEME;
use crate::plugins::api::test_rig::{insert_track, ID};
use crate::plugins::state::EnabledSet;

#[test]
fn a_failed_ambient_read_fires_nothing() {
    let mut bench = Bench::new(&[]);
    bench.subscribe(json!(["theme", "locale", "app_mode"]));
    bench.rig.host.unreadable = true;
    bench
        .rig
        .host
        .settings
        .insert(SETTING_THEME.into(), "dark".into());
    bench.handle(Input::Ambient);
    assert!(bench.sent().is_empty());
    // Once the read succeeds again, the real change lands.
    bench.rig.host.unreadable = false;
    bench.handle(Input::Ambient);
    assert_eq!(
        bench.sent(),
        [("theme".to_string(), json!({ "theme": "dark" }))]
    );
}

#[test]
fn a_failed_track_read_composes_nothing() {
    let mut bench = reader();
    let (a, b) = {
        let conn = bench.rig.conn();
        (
            insert_track(&conn, "C:\\Music\\a.flac", "First", "A"),
            insert_track(&conn, "C:\\Music\\b.flac", "Second", "B"),
        )
    };
    bench.status(|s| s.track_id = Some(a));
    bench.subscribe(json!(["now_playing"]));
    bench.status(|s| s.track_id = Some(b));
    let rename = |bench: &Bench, from: &str, to: &str| {
        let sql = format!("ALTER TABLE {from} RENAME TO {to}");
        bench.rig.conn().execute_batch(&sql).unwrap();
    };
    rename(&bench, "tracks", "tracks_moved");
    bench.handle(Input::Status);
    assert!(bench.sent().is_empty());
    assert!(!bench.hub.holds_a_track());
    rename(&bench, "tracks_moved", "tracks");
    bench.handle(Input::Status);
    let sent = bench.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1["track"]["title"], "Second");
}

#[test]
fn an_older_status_never_follows_a_newer_reply() {
    let mut bench = reader();
    bench.status(|s| {
        s.track_id = Some(5);
        s.playing = true;
        s.start_seq = 2;
        s.seek_seq = 1;
    });
    bench.subscribe(json!(["playback_state"]));
    // A snapshot read before the reply's, offered after it: its counters are behind, so it is dropped.
    bench.status(|s| {
        s.start_seq = 1;
        s.playing = false;
    });
    bench.handle(Input::Status);
    bench.status(|s| {
        s.start_seq = 2;
        s.seek_seq = 0;
    });
    bench.handle(Input::Status);
    assert!(bench.sent().is_empty());
    // A newer one goes out.
    bench.status(|s| {
        s.start_seq = 2;
        s.seek_seq = 2;
    });
    bench.handle(Input::Status);
    let sent = bench.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        (
            sent[0].1["start_seq"].clone(),
            sent[0].1["seek_seq"].clone()
        ),
        (json!(2), json!(2))
    );
}

#[test]
fn a_trailing_value_is_never_delivered_once_the_plugin_stops_serving() {
    for disabled in [false, true] {
        let mut bench = Bench::new(&[]);
        bench.subscribe(json!(["theme"]));
        let t0 = Instant::now();
        let enabled = bench.rig.plugins.enabled_set();
        let set_theme = |bench: &mut Bench, theme: &str| {
            bench
                .rig
                .host
                .settings
                .insert(SETTING_THEME.into(), theme.into());
        };
        set_theme(&mut bench, "dark");
        let env = Env {
            api: bench.rig.plugins.api(),
            enabled: &enabled,
            host: &bench.rig.host,
        };
        bench.hub.handle(&env, Input::Ambient, t0, 0);
        assert_eq!(bench.sent().len(), 1);
        set_theme(&mut bench, "light");
        let env = Env {
            api: bench.rig.plugins.api(),
            enabled: &enabled,
            host: &bench.rig.host,
        };
        bench
            .hub
            .handle(&env, Input::Ambient, t0 + Duration::from_millis(10), 0);
        assert!(bench.sent().is_empty());
        // The value waits; then the plugin is disabled, or its serving entry is gone at delivery.
        let gone = EnabledSet::default();
        let env = Env {
            api: bench.rig.plugins.api(),
            enabled: if disabled { &enabled } else { &gone },
            host: &bench.rig.host,
        };
        if disabled {
            bench.rig.plugins.api().forget(ID);
        }
        bench.hub.flush(&env, t0 + GAP);
        assert!(bench.sent().is_empty(), "disabled: {disabled}");
        let events = bench.rig.plugins.api().events();
        assert!(events.topics_of(ID, Side::Frame).is_empty());
        assert_eq!(events.next_due(), None);
    }
}

#[test]
fn a_refresh_lands_a_change_made_during_the_reply() {
    let mut bench = reader();
    bench.status(|s| {
        s.track_id = Some(5);
        s.playing = true;
    });
    bench.subscribe(json!(["playback_state", "theme"]));
    // Nothing changed since the reply: the refresh sends nothing.
    let refresh = Topic::PlaybackState.bit() | Topic::Theme.bit();
    bench.handle(Input::Refresh(refresh));
    assert!(bench.sent().is_empty());
    // A pause between the reply's read and the seat of its lane reaches the plugin on the refresh.
    bench.status(|s| s.playing = false);
    bench.handle(Input::Refresh(refresh));
    let sent = bench.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "playback_state");
    assert_eq!(sent[0].1["transport"], "paused");
}
