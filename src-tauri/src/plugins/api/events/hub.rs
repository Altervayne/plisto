/*
 * The event hub: one thread, `plisto-plugin-events`, fed by `EventSubs::feed` from the player's and
 * the stream's events, the settings writes, the OS theme and the frontend's library reports. Each
 * input composes the topics someone listens to, once, and offers them to the listeners' lanes.
 * Before a value leaves, the plugin's serving entry is read again: a plugin that no longer serves
 * loses its subscriptions, and one that lost a topic's grant loses that topic. A topic whose source
 * cannot be read (the player snapshot, the playing track's row, a setting or the OS theme) composes
 * nothing and its lanes keep the last value, so a failed read never passes for a change.
 */

// -- Library Imports --
use std::io;
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crossbeam_channel::RecvTimeoutError;
use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Listener, Manager};

// -- Local Imports --
use super::compose::{self, library_track, now_playing, playback_state, queue, NowPlaying};
use super::subs::{Delivery, Side};
use super::{bits, ChildDelivery, Input, Topic};
use crate::audio::PlayerStatus;
use crate::plugins::api::app::{
    resolve_app_mode, resolve_locale, resolve_theme, SETTING_APP_MODE, SETTING_LOCALE,
    SETTING_PLAYER_ENABLED, SETTING_THEME,
};
use crate::plugins::api::error::ApiError;
use crate::plugins::api::host_event::{HostEvent, TopicEvent};
use crate::plugins::api::library_rows::tracks_by_id;
use crate::plugins::api::state::ApiState;
use crate::plugins::api::stream::StreamNow;
use crate::plugins::api::tauri_host::TauriHost;
use crate::plugins::api::{HostContext, Need};
use crate::plugins::state::EnabledSet;
use crate::state::AppState;

const AMBIENT: [Topic; 3] = [Topic::Theme, Topic::Locale, Topic::AppMode];

/// What the hub reads and sends through.
pub struct Env<'a> {
    pub api: &'a ApiState,
    pub enabled: &'a EnabledSet,
    pub host: &'a dyn HostContext,
}

fn player_bits() -> u8 {
    bits(&[Topic::NowPlaying, Topic::PlaybackState, Topic::Queue])
}

pub fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn status(host: &dyn HostContext) -> Option<PlayerStatus> {
    let app = host.app_state()?;
    let status = app.player_status.lock().ok()?;
    Some(status.clone())
}

/// The row of library track `id` as `playback.state` returns it; None when it is gone.
fn track_row(env: &Env<'_>, id: i64) -> Result<Option<Value>, ApiError> {
    let app = env.host.app_state().ok_or_else(ApiError::unavailable)?;
    let read = |conn: &Connection| tracks_by_id(conn, &[id]).map_err(|_| ApiError::unavailable());
    // A database with no file has no second connection to open.
    let mut rows = if app.db_path.as_os_str().is_empty() {
        let conn = app.db.lock().map_err(|_| ApiError::unavailable())?;
        read(&conn)?
    } else {
        env.api.with_reader(&app.db_path, read)?
    };
    Ok(rows.pop().and_then(|row| serde_json::to_value(row).ok()))
}

/// The resolved setting behind an ambient topic; None when a read it needs fails.
fn resolved(host: &dyn HostContext, topic: Topic) -> Option<&'static str> {
    let setting = |key: &str| host.read_setting(key);
    match topic {
        Topic::Theme => {
            let theme = setting(SETTING_THEME)?;
            // The OS theme counts only for a user who follows the system.
            let dark = match theme.as_deref() {
                Some("light" | "dark") => false,
                _ => host.read_os_dark()?,
            };
            Some(resolve_theme(theme.as_deref(), dark))
        }
        Topic::Locale => Some(resolve_locale(setting(SETTING_LOCALE)?.as_deref())),
        Topic::AppMode => Some(resolve_app_mode(
            setting(SETTING_APP_MODE)?.as_deref(),
            setting(SETTING_PLAYER_ENABLED)?.as_deref(),
        )),
        _ => None,
    }
}

fn ambient(host: &dyn HostContext, topic: Topic) -> Option<Value> {
    compose::ambient(topic, resolved(host, topic)?)
}

/// The values a subscribe answers with, and the seated item they were read with.
pub struct Current {
    pub values: Vec<(Topic, Value)>,
    pub item: Option<i64>,
}

/// The value of each state topic of `topics` for plugin `id`, read now. A topic whose source cannot
/// be read is left out.
pub fn current(env: &Env<'_>, id: &str, topics: &[Topic], unix_ms: i64) -> Current {
    let wanted = bits(topics);
    let status = match wanted & player_bits() {
        0 => None,
        _ => status(env.host),
    };
    let stream = match wanted & bits(&[Topic::NowPlaying, Topic::PlaybackState]) {
        0 => None,
        _ => env.api.streams().now(),
    };
    let mut values = Vec::new();
    for &topic in topics {
        let value = match (topic, &status) {
            (Topic::PlaybackState, Some(status)) => {
                Some(playback_state(status, stream.as_ref(), unix_ms))
            }
            (Topic::Queue, Some(status)) => Some(queue(status, env.api.events().queue_rev())),
            (Topic::NowPlaying, Some(status)) => {
                // None when the playing track's row cannot be read.
                let track = match library_track(status, stream.as_ref()) {
                    Some(track_id) => track_row(env, track_id).ok(),
                    None => Some(None),
                };
                track.map(|track| now_playing(status, stream.as_ref(), track).render(id))
            }
            _ => ambient(env.host, topic),
        };
        if let Some(value) = value {
            values.push((topic, value));
        }
    }
    Current {
        values,
        item: status.and_then(|status| status.track_id),
    }
}

#[derive(Default)]
pub struct EventHub {
    // The row of the playing library track, by id: read again when the id changes or the track is
    // reported changed.
    track: Option<(i64, Option<Value>)>,
}

impl EventHub {
    /// Composes what `input` can change for the topics someone listens to, and delivers it.
    pub fn handle(&mut self, env: &Env<'_>, input: Input, now: Instant, unix_ms: i64) {
        let events = env.api.events();
        let mask = events.mask();
        if mask & Topic::NowPlaying.bit() == 0 {
            self.track = None;
        }
        let mut out = Vec::new();
        let wanted = match input {
            Input::Queue => {
                events.bump_queue_rev();
                Topic::Queue.bit()
            }
            Input::Library(change) => {
                let change = change.normalized();
                if mask & Topic::LibraryChanged.bit() != 0 {
                    let value = change.to_value();
                    out = events.offer(Topic::LibraryChanged, now, &|_| value.clone());
                }
                let stale = self.track.as_ref().is_some_and(|(id, _)| {
                    change.track_ids.as_ref().is_none_or(|ids| ids.contains(id))
                });
                if !stale {
                    0
                } else {
                    self.track = None;
                    Topic::NowPlaying.bit()
                }
            }
            Input::Refresh(topics) => {
                if topics & Topic::NowPlaying.bit() != 0 {
                    self.track = None;
                }
                topics
            }
            other => other.bits(),
        };
        out.extend(self.compose(env, wanted & mask, now, unix_ms));
        deliver(env, out, now);
    }

    /// Delivers every pending value whose gap has passed.
    pub fn flush(&mut self, env: &Env<'_>, now: Instant) {
        deliver(env, env.api.events().due(now), now);
    }

    fn compose(&mut self, env: &Env<'_>, wanted: u8, now: Instant, unix_ms: i64) -> Vec<Delivery> {
        let events = env.api.events();
        let mut out = Vec::new();
        if wanted & player_bits() != 0 {
            if let Some(status) = status(env.host) {
                let stream = match wanted & bits(&[Topic::NowPlaying, Topic::PlaybackState]) {
                    0 => None,
                    _ => env.api.streams().now(),
                };
                if wanted & Topic::PlaybackState.bit() != 0 {
                    let value = playback_state(&status, stream.as_ref(), unix_ms);
                    out.extend(events.offer(Topic::PlaybackState, now, &|_| value.clone()));
                }
                if wanted & Topic::Queue.bit() != 0 {
                    let value = queue(&status, events.queue_rev());
                    out.extend(events.offer(Topic::Queue, now, &|_| value.clone()));
                }
                if wanted & Topic::NowPlaying.bit() != 0 {
                    if let Some(shown) = self.now_playing(env, &status, stream.as_ref()) {
                        let item = status.track_id;
                        let render = |id: &str| shown.render(id);
                        out.extend(events.offer_seated(Topic::NowPlaying, now, item, &render));
                    }
                }
            }
        }
        for topic in AMBIENT.into_iter().filter(|t| wanted & t.bit() != 0) {
            if let Some(value) = ambient(env.host, topic) {
                out.extend(events.offer(topic, now, &|_| value.clone()));
            }
        }
        out
    }

    /// `now_playing`, reading the track's row only when it is not the one held. None when the row
    /// cannot be read.
    fn now_playing(
        &mut self,
        env: &Env<'_>,
        status: &PlayerStatus,
        stream: Option<&StreamNow>,
    ) -> Option<NowPlaying> {
        let track = match library_track(status, stream) {
            None => None,
            Some(id) => match &self.track {
                Some((held, row)) if *held == id => row.clone(),
                _ => {
                    let row = track_row(env, id).ok()?;
                    self.track = Some((id, row.clone()));
                    row
                }
            },
        };
        Some(now_playing(status, stream, track))
    }

    #[cfg(test)]
    pub(super) fn holds_a_track(&self) -> bool {
        self.track.is_some()
    }
}

/// Sends each value to its receiver once its plugin is seen to still serve with the topic's grant.
fn deliver(env: &Env<'_>, deliveries: Vec<Delivery>, now: Instant) {
    let events = env.api.events();
    for delivery in deliveries {
        let Some(serving) = env.enabled.serving(&delivery.id) else {
            events.forget(&delivery.id);
            continue;
        };
        if let Need::Cap(cap) = delivery.topic.need() {
            if !serving.granted.contains(&cap) {
                events.drop_topic(&delivery.id, delivery.side, delivery.topic);
                continue;
            }
        }
        match delivery.side {
            Side::Frame => env.host.emit(HostEvent::Topic(TopicEvent {
                id: delivery.id,
                topic: delivery.topic.name().to_string(),
                data: delivery.data,
                seq: delivery.seq,
            })),
            Side::Child => {
                let (topic, seq) = (delivery.topic.name(), delivery.seq);
                let taken = env.host.deliver_event(&delivery.id, topic, &delivery.data, seq);
                // A stale value is superseded by the answer the child already has: not retried.
                if taken == ChildDelivery::Full {
                    events.defer(delivery, now);
                }
            }
        }
    }
}

/// Feeds the player's and the stream's events to the hub. Each listener does one atomic load while
/// nobody listens.
fn listen(app: &AppHandle, api: &ApiState) {
    let feed = |input: fn() -> Input| {
        let api = api.clone();
        move |_: tauri::Event| api.events().feed(input())
    };
    app.listen("player:status", feed(|| Input::Status));
    app.listen("player:queue", feed(|| Input::Queue));
    app.listen("player:stream", feed(|| Input::Stream));
}

/// Starts the hub thread. Needs the managed `AppState`.
pub fn spawn(app: &AppHandle) -> io::Result<()> {
    let (api, enabled) = {
        let state = app.state::<AppState>();
        (state.plugins.api().clone(), state.plugins.enabled_set())
    };
    let (tx, rx) = crossbeam_channel::unbounded();
    api.events().attach(tx);
    listen(app, &api);
    let host = TauriHost::new(app.clone());
    thread::Builder::new()
        .name("plisto-plugin-events".into())
        .spawn(move || {
            let env = Env {
                api: &api,
                enabled: &enabled,
                host: &host,
            };
            let mut hub = EventHub::default();
            loop {
                let input = match api.events().next_due() {
                    Some(at) => rx.recv_deadline(at),
                    None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
                };
                match input {
                    Ok(input) => hub.handle(&env, input, Instant::now(), unix_ms()),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                hub.flush(&env, Instant::now());
            }
        })
        .map(drop)
}
