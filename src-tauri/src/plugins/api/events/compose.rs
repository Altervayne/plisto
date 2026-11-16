/*
 * The topic values, from the player snapshot, the seated stream, the settings and a library change.
 * Pure: every input is read by the caller. A payload carries library ids, player numbers and flags,
 * the playing library track's row as `playback.state` returns it, the stream's cleaned title and
 * artist, and resolved settings; never a path, a device, a URL or a plugin's identity. A stream's
 * owner is kept beside the value, so each subscriber is told only whether the stream is its own.
 */

// -- Library Imports --
use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// -- Local Imports --
use super::Topic;
use crate::adhoc::is_ad_hoc;
use crate::audio::{PlayerStatus, StreamPhase};
use crate::plugins::api::stream::{NowState, StreamNow};

/// The most ids one `library_changed` lists; more reads as unknown.
pub const MAX_CHANGED_IDS: usize = 500;

/// The seated stream as `now_playing` shows it.
#[derive(Clone, Debug, PartialEq)]
struct StreamShown {
    title: String,
    artist: Option<String>,
    live: bool,
    owner: String,
}

/// `now_playing` before it is told to one plugin.
#[derive(Clone, Debug, PartialEq)]
pub struct NowPlaying {
    source: Option<&'static str>,
    track_id: Option<i64>,
    track: Option<Value>,
    stream: Option<StreamShown>,
}

impl NowPlaying {
    /// The payload plugin `id` receives.
    pub fn render(&self, id: &str) -> Value {
        let stream = self.stream.as_ref().map(|s| {
            json!({ "title": s.title, "artist": s.artist, "live": s.live, "mine": s.owner == id })
        });
        json!({
            "source": self.source,
            "track_id": self.track_id,
            "track": self.track,
            "stream": stream,
        })
    }
}

/// Whether the seated item is a plugin stream.
fn is_stream(status: &PlayerStatus, stream: Option<&StreamNow>) -> bool {
    status.stream.is_some() || stream.is_some_and(|now| Some(now.item) == status.track_id)
}

/// The library track whose row `now_playing` carries; None for a file, a stream or nothing.
pub fn library_track(status: &PlayerStatus, stream: Option<&StreamNow>) -> Option<i64> {
    let id = status.track_id?;
    (!is_ad_hoc(id) && !is_stream(status, stream)).then_some(id)
}

/// `now_playing`, with `track` the row of `library_track`: None when it is gone.
pub fn now_playing(
    status: &PlayerStatus,
    stream: Option<&StreamNow>,
    track: Option<Value>,
) -> NowPlaying {
    let Some(id) = status.track_id else {
        return NowPlaying {
            source: None,
            track_id: None,
            track: None,
            stream: None,
        };
    };
    if is_stream(status, stream) {
        return NowPlaying {
            source: Some("stream"),
            track_id: None,
            track: None,
            stream: stream.map(|now| StreamShown {
                title: now.title.clone(),
                artist: now.artist.clone(),
                live: now.live,
                owner: now.plugin_id.clone(),
            }),
        };
    }
    if is_ad_hoc(id) {
        return NowPlaying {
            source: Some("file"),
            track_id: None,
            track: None,
            stream: None,
        };
    }
    NowPlaying {
        source: Some("library"),
        track_id: Some(id),
        track,
        stream: None,
    }
}

fn transport(status: &PlayerStatus, stream: Option<&StreamNow>) -> &'static str {
    if status.track_id.is_none() {
        return "stopped";
    }
    if let Some(seated) = &status.stream {
        if stream.is_some_and(|now| now.state == NowState::Reconnecting) {
            return "buffering";
        }
        return match seated.phase {
            StreamPhase::Connecting | StreamPhase::Buffering => "buffering",
            StreamPhase::Playing => "playing",
            StreamPhase::Paused => "paused",
        };
    }
    if status.playing {
        "playing"
    } else {
        "paused"
    }
}

/// `playback_state`, stamped with `unix_ms`, the time the snapshot was read.
pub fn playback_state(status: &PlayerStatus, stream: Option<&StreamNow>, unix_ms: i64) -> Value {
    let live = status.stream.as_ref().is_some_and(|s| s.live);
    let duration = status.duration_secs;
    let duration = if live || !duration.is_finite() || duration < 0.0 {
        0.0
    } else {
        duration
    };
    let seated = status
        .stream
        .as_ref()
        .map(|s| json!({ "phase": s.phase, "live": s.live, "seekable": s.seekable }));
    json!({
        "transport": transport(status, stream),
        "position_secs": status.position_secs,
        "position_at": unix_ms,
        "duration_secs": duration,
        "start_seq": status.start_seq,
        "seek_seq": status.seek_seq,
        "repeat": status.repeat,
        "shuffle": status.shuffle,
        "volume": status.volume,
        "stream": seated,
    })
}

/// `queue`; `rev` counts the queue's content and order changes.
pub fn queue(status: &PlayerStatus, rev: u64) -> Value {
    json!({
        "index": status.queue_index,
        "length": status.queue_len,
        "rev": rev,
        "parked": status.stream.is_some(),
    })
}

/// The value of an ambient topic from its resolved setting; None for any other topic.
pub fn ambient(topic: Topic, resolved: &str) -> Option<Value> {
    match topic {
        Topic::Theme => Some(json!({ "theme": resolved })),
        Topic::Locale => Some(json!({ "locale": resolved })),
        Topic::AppMode => Some(json!({ "app_mode": resolved })),
        _ => None,
    }
}

/// The counters of a `playback_state` value, which only move forward; None for any other topic.
pub fn order(topic: Topic, value: &Value) -> Option<[u64; 2]> {
    if topic != Topic::PlaybackState {
        return None;
    }
    Some([value["start_seq"].as_u64()?, value["seek_seq"].as_u64()?])
}

/// What a value is compared by: `playback_state` without its position, every other value whole.
/// A position tick alone is therefore no change.
pub fn key(topic: Topic, value: &Value) -> Value {
    let mut key = value.clone();
    if topic == Topic::PlaybackState {
        if let Some(fields) = key.as_object_mut() {
            fields.remove("position_secs");
            fields.remove("position_at");
        }
    }
    key
}

/// `library_changed`: changed or removed ids, None for many or unknown, and the scopes touched.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryChange {
    pub track_ids: Option<Vec<i64>>,
    pub albums: bool,
    pub playlists: bool,
}

impl LibraryChange {
    /// The ids sorted and unique, and None past `MAX_CHANGED_IDS`.
    pub fn normalized(self) -> LibraryChange {
        LibraryChange {
            track_ids: self
                .track_ids
                .and_then(|ids| capped(ids.into_iter().collect())),
            ..self
        }
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

fn capped(ids: BTreeSet<i64>) -> Option<Vec<i64>> {
    (ids.len() <= MAX_CHANGED_IDS).then(|| ids.into_iter().collect())
}

/// Two changes inside one window as one: ids unioned, scopes ORed, unknown ids winning.
pub fn merge_library(older: Value, newer: Value) -> Value {
    let read = |value: Value| serde_json::from_value::<LibraryChange>(value).unwrap_or_default();
    let (older, newer) = (read(older), read(newer));
    let track_ids = match (older.track_ids, newer.track_ids) {
        (Some(a), Some(b)) => capped(a.into_iter().chain(b).collect()),
        _ => None,
    };
    LibraryChange {
        track_ids,
        albums: older.albums || newer.albums,
        playlists: older.playlists || newer.playlists,
    }
    .to_value()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{RepeatMode, StreamStatus};
    use crate::plugins::api::library_rows::tracks_by_id;
    use crate::plugins::api::stream::Skip;
    use crate::plugins::api::test_rig::{insert_track, Rig};
    use crate::plugins::manifest::Capability;

    const ME: &str = "com.example.demo";
    const OTHER: &str = "com.secret.owner";

    fn stream_now(item: i64, owner: &str) -> StreamNow {
        StreamNow {
            item,
            plugin_id: owner.into(),
            plugin_name: "Secret Owner Radio".into(),
            title: "Song".into(),
            artist: Some("Band".into()),
            album: Some("Hidden Album".into()),
            now: Some("https://radio.example/now?token=1".into()),
            live: true,
            seekable: false,
            duration_secs: None,
            state: NowState::Playing,
            skip: Skip::default(),
            art_rev: 3,
            rev: 7,
        }
    }

    fn seated(phase: StreamPhase) -> StreamStatus {
        StreamStatus {
            live: true,
            seekable: false,
            phase,
            parked: None,
            parked_cleared: false,
        }
    }

    #[test]
    fn library_merge_unions_ids_and_caps_at_500() {
        let change = |ids: Option<Vec<i64>>, albums, playlists| {
            LibraryChange {
                track_ids: ids,
                albums,
                playlists,
            }
            .to_value()
        };
        assert_eq!(
            merge_library(
                change(Some(vec![3, 1]), false, true),
                change(Some(vec![2, 3]), true, false)
            ),
            change(Some(vec![1, 2, 3]), true, true)
        );
        // Unknown on either side stays unknown.
        assert_eq!(
            merge_library(
                change(None, false, false),
                change(Some(vec![1]), false, false)
            ),
            change(None, false, false)
        );
        let first: Vec<i64> = (1..=300).collect();
        let second: Vec<i64> = (201..=500).collect();
        let merged = merge_library(
            change(Some(first), false, false),
            change(Some(second), false, false),
        );
        assert_eq!(merged["track_ids"].as_array().unwrap().len(), 500);
        let over: Vec<i64> = (400..=600).collect();
        assert_eq!(
            merge_library(merged, change(Some(over), false, false))["track_ids"],
            Value::Null
        );
        // A report is sorted, unique and capped the same way.
        let reported = LibraryChange {
            track_ids: Some(vec![5, 5, 4]),
            albums: true,
            playlists: false,
        };
        assert_eq!(reported.normalized().track_ids, Some(vec![4, 5]));
        let many = LibraryChange {
            track_ids: Some((0..501).collect()),
            ..LibraryChange::default()
        };
        assert_eq!(many.normalized().track_ids, None);
    }

    #[test]
    fn another_plugins_stream_is_reported_without_identity() {
        let status = PlayerStatus {
            track_id: Some(-9),
            stream: Some(seated(StreamPhase::Playing)),
            ..PlayerStatus::default()
        };
        let now = stream_now(-9, OTHER);
        let shown = now_playing(&status, Some(&now), None);
        let theirs = shown.render(ME);
        assert_eq!(
            theirs,
            json!({ "source": "stream", "track_id": null, "track": null,
                    "stream": { "title": "Song", "artist": "Band", "live": true, "mine": false } })
        );
        assert_eq!(shown.render(OTHER)["stream"]["mine"], true);
        let text = theirs.to_string();
        for needle in [OTHER, "Secret", "Hidden", "https", "radio.example", "-9"] {
            assert!(!text.contains(needle), "{needle} in {text}");
        }
        // The engine may report the stream before its snapshot names it, and the reverse.
        let early = PlayerStatus {
            track_id: Some(-9),
            ..PlayerStatus::default()
        };
        assert_eq!(
            now_playing(&early, Some(&now), None).render(ME)["source"],
            "stream"
        );
        assert_eq!(
            now_playing(&status, None, None).render(ME)["stream"],
            Value::Null
        );
    }

    #[test]
    fn transport_reads_the_stream_phase_and_a_reconnect_as_buffering() {
        let mut status = PlayerStatus::default();
        assert_eq!(transport(&status, None), "stopped");
        status.track_id = Some(4);
        assert_eq!(transport(&status, None), "paused");
        status.playing = true;
        assert_eq!(transport(&status, None), "playing");
        status.track_id = Some(-2);
        for (phase, want) in [
            (StreamPhase::Connecting, "buffering"),
            (StreamPhase::Buffering, "buffering"),
            (StreamPhase::Playing, "playing"),
            (StreamPhase::Paused, "paused"),
        ] {
            status.stream = Some(seated(phase));
            assert_eq!(transport(&status, None), want);
        }
        let mut now = stream_now(-2, OTHER);
        now.state = NowState::Reconnecting;
        status.stream = Some(seated(StreamPhase::Playing));
        assert_eq!(transport(&status, Some(&now)), "buffering");
        // A live stream has no duration.
        status.duration_secs = 30.0;
        assert_eq!(playback_state(&status, None, 1)["duration_secs"], 0.0);
    }

    #[test]
    fn a_position_tick_keeps_the_key() {
        let mut status = PlayerStatus {
            track_id: Some(1),
            playing: true,
            ..PlayerStatus::default()
        };
        let before = playback_state(&status, None, 1_000);
        status.position_secs = 12.5;
        let after = playback_state(&status, None, 2_000);
        assert_ne!(before, after);
        assert_eq!(
            key(Topic::PlaybackState, &before),
            key(Topic::PlaybackState, &after)
        );
        status.seek_seq += 1;
        let sought = playback_state(&status, None, 3_000);
        assert_ne!(
            key(Topic::PlaybackState, &after),
            key(Topic::PlaybackState, &sought)
        );
    }

    #[test]
    fn no_payload_contains_a_path() {
        let rig = Rig::new(&[Capability::PlaybackRead]);
        let id = insert_track(&rig.conn(), "C:\\Music\\Secret\\x.flac", "T", "A");
        let track = tracks_by_id(&rig.conn(), &[id]).unwrap().pop().unwrap();
        let track = serde_json::to_value(track).unwrap();
        let device = Some("Speakers (C:\\Device\\Out)".to_string());
        let playing = PlayerStatus {
            playing: true,
            track_id: Some(id),
            position_secs: 3.0,
            duration_secs: 200.0,
            repeat: RepeatMode::All,
            queue_len: 3,
            output_device: device.clone(),
            ..PlayerStatus::default()
        };
        let parked = crate::audio::ParkedStatus {
            track_id: id,
            secs: 1.0,
        };
        let streaming = PlayerStatus {
            track_id: Some(-7),
            output_device: device,
            stream: Some(StreamStatus {
                parked: Some(parked),
                ..seated(StreamPhase::Buffering)
            }),
            ..PlayerStatus::default()
        };
        let now = stream_now(-7, OTHER);
        let mut payloads = vec![
            now_playing(&playing, None, Some(track)).render(ME),
            now_playing(&streaming, Some(&now), None).render(ME),
            playback_state(&playing, None, 1),
            playback_state(&streaming, Some(&now), 1),
            queue(&playing, 4),
            queue(&streaming, 5),
            LibraryChange {
                track_ids: Some(vec![id]),
                albums: true,
                playlists: true,
            }
            .to_value(),
        ];
        for (topic, resolved) in [
            (Topic::Theme, "dark"),
            (Topic::Locale, "fr"),
            (Topic::AppMode, "both"),
        ] {
            payloads.push(ambient(topic, resolved).unwrap());
        }
        for payload in payloads {
            let text = payload.to_string();
            for needle in [
                "C:", "\\", "Music", ".flac", "Device", "Speakers", OTHER, "Secret", "http",
            ] {
                assert!(!text.contains(needle), "{needle} in {text}");
            }
        }
    }
}
