// -- Library Imports --
use std::collections::BTreeSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// -- Local Imports --
use super::coalesce::GAP;
use super::hub::{Env, EventHub};
use super::tests_hub::{reader, Bench};
use super::{ChildDelivery, Input, Side, Topic};
use crate::plugins::api::app::{SETTING_LOCALE, SETTING_THEME};
use crate::plugins::api::error::ApiError;
use crate::plugins::api::host_event::HostEvent;
use crate::plugins::api::test_rig::{insert_track, Rig, ID};
use crate::plugins::api::{FakeHost, HostContext};
use crate::plugins::state::EnabledSet;
use crate::state::AppState;

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

/// A host whose child has no room for its first `full` deliveries and takes every later one.
struct ChildHost {
    inner: FakeHost,
    full: Mutex<u32>,
    taken: Mutex<Vec<(String, Value)>>,
}

impl HostContext for ChildHost {
    fn setting(&self, key: &str) -> Option<String> {
        self.inner.setting(key)
    }

    fn os_prefers_dark(&self) -> bool {
        self.inner.os_prefers_dark()
    }

    fn emit(&self, event: HostEvent) {
        self.inner.emit(event);
    }

    fn main_window_shown(&self) -> bool {
        self.inner.main_window_shown()
    }

    fn app_state(&self) -> Option<&AppState> {
        self.inner.app_state()
    }

    fn relay_call(&self, id: &str, method: &str, args: Value) -> Result<Value, ApiError> {
        self.inner.relay_call(id, method, args)
    }

    fn deliver_event(&self, _id: &str, topic: &str, data: &Value, _seq: u64) -> ChildDelivery {
        let mut full = self.full.lock().unwrap();
        if *full > 0 {
            *full -= 1;
            return ChildDelivery::Full;
        }
        self.taken.lock().unwrap().push((topic.to_string(), data.clone()));
        ChildDelivery::Sent
    }
}

#[test]
fn a_full_outbox_defers_and_lands_the_last_value() {
    let rig = Rig::new(&[]);
    let (api, enabled) = (rig.plugins.api(), rig.plugins.enabled_set());
    api.events()
        .replace(ID, Side::Child, &BTreeSet::from([Topic::Locale]), &[]);
    let mut host = ChildHost {
        inner: FakeHost::default(),
        full: Mutex::new(0),
        taken: Mutex::new(Vec::new()),
    };
    let mut hub = EventHub::default();
    let t0 = Instant::now();
    let locale = |host: &mut ChildHost, value: &str| {
        host.inner.settings.insert(SETTING_LOCALE.into(), value.into());
    };
    let taken = |host: &ChildHost| host.taken.lock().unwrap().clone();
    let en = ("locale".to_string(), json!({ "locale": "en" }));
    let fr = ("locale".to_string(), json!({ "locale": "fr" }));

    // The child has no room for "fr"; a newer "en" arrives inside the gap and replaces it.
    *host.full.lock().unwrap() = 1;
    locale(&mut host, "fr");
    let env = Env { api, enabled: &enabled, host: &host };
    hub.handle(&env, Input::Ambient, t0, 0);
    assert!(taken(&host).is_empty());
    locale(&mut host, "en");
    let env = Env { api, enabled: &enabled, host: &host };
    hub.handle(&env, Input::Ambient, t0 + GAP / 2, 0);
    hub.flush(&env, t0 + GAP / 2);
    assert!(taken(&host).is_empty());
    hub.flush(&env, t0 + GAP);
    assert_eq!(taken(&host), std::slice::from_ref(&en));
    hub.flush(&env, t0 + GAP * 8);
    assert_eq!(taken(&host).len(), 1);
    assert_eq!(api.events().next_due(), None);

    // With nothing newer, the deferred value itself is retried at the next tick and lands.
    let later = t0 + Duration::from_secs(5);
    *host.full.lock().unwrap() = 1;
    locale(&mut host, "fr");
    let env = Env { api, enabled: &enabled, host: &host };
    hub.handle(&env, Input::Ambient, later, 0);
    assert_eq!(taken(&host).len(), 1);
    assert_eq!(api.events().next_due(), Some(later + GAP));
    hub.flush(&env, later + GAP);
    assert_eq!(taken(&host), [en, fr]);
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
