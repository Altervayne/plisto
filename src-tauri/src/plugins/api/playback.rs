/*
 * The playback methods: what is playing and the queue, read from the engine's shared snapshots, and
 * the player commands a plugin may send. Queue changes take library track ids, an album or a playlist,
 * need `library.read` beside `playback.control`, and go through the same resolution the app's own
 * play commands use, so a plugin queues exactly what a click would: a playlist's keep-order album
 * entries go as blocks. Tracks missing on disk are left out. A track played straight off disk, or a
 * plugin stream, has no library id and reads as null, so its file is never named; a stream is
 * described by its cleaned title and artist only.
 */

// -- Library Imports --
use serde_json::{json, Map, Value};

// -- Local Imports --
use super::error::ApiError;
use super::library::{app_state, db, id_list, with_conn};
use super::library_rows::{album_track_ids, playlist_track_ids, present_ids, tracks_by_id};
use super::rate::RateClass;
use super::{CallCtx, MethodSpec, Need, Outcome};
use crate::adhoc::is_ad_hoc;
use crate::audio::PlayerCmd;
use crate::commands::player::resolve_with_blocks;
use crate::plugins::manifest::Capability;
use crate::state::AppState;

/// The most track ids one queue change takes.
pub const MAX_QUEUE_IDS: usize = 500;

const READ: Need = Need::Cap(Capability::PlaybackRead);
const CONTROL: Need = Need::Cap(Capability::PlaybackControl);
// A queue change names library ids, and its answer tells which exist and how many tracks an album
// or playlist holds, so it needs the library grant as well.
const QUEUE: Need = Need::All(&[Capability::PlaybackControl, Capability::LibraryRead]);

const fn control(name: &'static str, need: Need, run: super::Handler) -> MethodSpec {
    MethodSpec {
        name,
        need,
        class: RateClass::Play,
        run,
    }
}

pub(super) const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "playback.state",
        need: READ,
        class: RateClass::PlaybackRead,
        run: state,
    },
    MethodSpec {
        name: "playback.queue",
        need: READ,
        class: RateClass::PlaybackRead,
        run: queue,
    },
    control("playback.toggle", CONTROL, toggle),
    control("playback.pause", CONTROL, pause),
    control("playback.resume", CONTROL, resume),
    control("playback.next", CONTROL, next),
    control("playback.prev", CONTROL, prev),
    control("playback.seek", CONTROL, seek),
    control("queue.play", QUEUE, queue_play),
    control("queue.add", QUEUE, queue_add),
    control("queue.play_next", QUEUE, queue_play_next),
];

/// A library id, or None for a track played off disk.
fn library_id(id: i64) -> Option<i64> {
    (!is_ad_hoc(id)).then_some(id)
}

fn state(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    Outcome::Done(read_state(ctx))
}

fn read_state(ctx: &CallCtx<'_>) -> Result<Value, ApiError> {
    let app = app_state(ctx)?;
    let status = app
        .player_status
        .lock()
        .map_err(|_| ApiError::unavailable())?
        .clone();
    let track_id = status.track_id.and_then(library_id);
    let track = match track_id {
        Some(id) => with_conn(ctx, |conn| db(tracks_by_id(conn, &[id])))?.pop(),
        None => None,
    };
    Ok(json!({
        "playing": status.playing,
        "track_id": track_id,
        "track": track,
        "position_secs": status.position_secs,
        "duration_secs": status.duration_secs,
        "volume": status.volume,
        "repeat": status.repeat,
        "shuffle": status.shuffle,
        "queue_index": status.queue_index,
        "queue_length": status.queue_len,
        "stream": ctx.api.streams().describe(ctx.id),
    }))
}

fn queue(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    Outcome::Done(read_queue(ctx))
}

/// The queue's ids and current index, plus `blocks` when the queue holds tracks that play together:
/// each a `{ start, length }` span over `track_ids`, as the engine holds it.
fn read_queue(ctx: &CallCtx<'_>) -> Result<Value, ApiError> {
    let app = app_state(ctx)?;
    let (ids, blocks) = {
        let mirror = app
            .player_queue
            .lock()
            .map_err(|_| ApiError::unavailable())?;
        let ids: Vec<Option<i64>> = mirror.ids.iter().map(|&id| library_id(id)).collect();
        (ids, mirror.blocks.clone())
    };
    let index = app
        .player_status
        .lock()
        .map_err(|_| ApiError::unavailable())?
        .queue_index;
    let mut reply = json!({ "track_ids": ids, "index": index });
    if !blocks.is_empty() {
        let spans: Vec<Value> = blocks
            .iter()
            .map(|&[start, length]| json!({ "start": start, "length": length }))
            .collect();
        reply["blocks"] = Value::Array(spans);
    }
    Ok(reply)
}

/// Sends one command to the engine. A closed channel means the player is gone.
fn send(app: &AppState, cmd: PlayerCmd) -> Result<(), ApiError> {
    app.player.send(cmd).map_err(|_| ApiError::unavailable())
}

fn command(ctx: &CallCtx<'_>, cmd: PlayerCmd) -> Outcome {
    Outcome::Done(
        app_state(ctx)
            .and_then(|app| send(app, cmd))
            .map(|()| json!({})),
    )
}

fn toggle(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    command(ctx, PlayerCmd::TogglePlay)
}

fn pause(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    command(ctx, PlayerCmd::Pause)
}

fn resume(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    command(ctx, PlayerCmd::Resume)
}

fn next(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    command(ctx, PlayerCmd::Next)
}

fn prev(ctx: &CallCtx<'_>, _args: &Map<String, Value>) -> Outcome {
    command(ctx, PlayerCmd::Prev)
}

/// Seeks to `secs`, held to the loaded track's length when the player reports one.
fn seek(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    match args.get("secs").and_then(Value::as_f64) {
        Some(secs) if secs.is_finite() && secs >= 0.0 => {
            let duration = app_state(ctx).ok().and_then(|app| {
                app.player_status
                    .lock()
                    .ok()
                    .map(|status| status.duration_secs)
            });
            let secs = match duration {
                Some(length) if length > 0.0 => secs.min(length),
                _ => secs,
            };
            command(ctx, PlayerCmd::Seek(secs))
        }
        _ => Outcome::Done(Err(ApiError::invalid_args(
            "'secs' must be a number of at least 0.",
        ))),
    }
}

/// What a queue change plays: library track ids, or every present track of an album or playlist.
enum Source {
    Tracks(Vec<i64>),
    Album(i64),
    Playlist(i64),
}

#[derive(Clone, Copy)]
enum QueueOp {
    Play,
    Add,
    PlayNext,
}

fn source_arg(args: &Map<String, Value>) -> Result<Source, ApiError> {
    let given = |name: &str| args.get(name).is_some_and(|v| !v.is_null());
    let count = ["track_ids", "album_id", "playlist_id"]
        .into_iter()
        .filter(|name| given(name))
        .count();
    if count != 1 {
        return Err(ApiError::invalid_args(
            "Give exactly one of 'track_ids', 'album_id' and 'playlist_id'.",
        ));
    }
    if given("track_ids") {
        return id_list(args, "track_ids", MAX_QUEUE_IDS).map(Source::Tracks);
    }
    let int = |name: &str| args.get(name).and_then(Value::as_i64);
    if given("album_id") {
        let id = int("album_id")
            .ok_or_else(|| ApiError::invalid_args("'album_id' must be an integer."))?;
        return Ok(Source::Album(id));
    }
    let id = int("playlist_id")
        .ok_or_else(|| ApiError::invalid_args("'playlist_id' must be an integer."))?;
    Ok(Source::Playlist(id))
}

fn start_arg(args: &Map<String, Value>) -> Result<usize, ApiError> {
    match args.get("start") {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_u64()
            .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
            .ok_or_else(|| ApiError::invalid_args("'start' must be an integer of at least 0.")),
    }
}

/// The present track ids `source` names, in its order, where `start` lands among them (a start on a
/// track left out moves to the next one kept), and the `[start, length]` spans of a playlist's
/// keep-order album entries.
fn source_ids(
    ctx: &CallCtx<'_>,
    source: Source,
    start: usize,
) -> Result<(Vec<i64>, usize, Vec<[usize; 2]>), ApiError> {
    with_conn(ctx, |conn| match source {
        Source::Tracks(ids) => {
            let present = db(present_ids(conn, &ids))?;
            let start = ids
                .iter()
                .take(start)
                .filter(|id| present.contains(id))
                .count();
            let kept = ids.into_iter().filter(|id| present.contains(id)).collect();
            Ok((kept, start, Vec::new()))
        }
        Source::Album(id) => db(album_track_ids(conn, id))?
            .map(|ids| (ids, start, Vec::new()))
            .ok_or_else(ApiError::not_found),
        Source::Playlist(id) => db(playlist_track_ids(conn, id))?
            .map(|(ids, spans)| (ids, start, spans))
            .ok_or_else(ApiError::not_found),
    })
}

fn change_queue(
    ctx: &CallCtx<'_>,
    args: &Map<String, Value>,
    op: QueueOp,
) -> Result<Value, ApiError> {
    let source = source_arg(args)?;
    let start = match op {
        QueueOp::Play => start_arg(args)?,
        QueueOp::Add | QueueOp::PlayNext => 0,
    };
    let (ids, start, spans) = source_ids(ctx, source, start)?;
    let app = app_state(ctx)?;
    // Takes the database lock itself, so none may be held here. A row that no longer resolves drops
    // out, and `start` and the block marks move with the rows kept.
    let (queue, start) = resolve_with_blocks(&ids, Some(spans), start, app);
    let queued = queue.len();
    if queued == 0 {
        return Ok(json!({ "queued": 0 }));
    }
    let cmd = match op {
        QueueOp::Play => PlayerCmd::Play {
            queue,
            index: start.min(queued - 1),
        },
        QueueOp::Add => PlayerCmd::Enqueue(queue),
        QueueOp::PlayNext => PlayerCmd::InsertNext(queue),
    };
    send(app, cmd)?;
    Ok(json!({ "queued": queued }))
}

fn queue_play(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(change_queue(ctx, args, QueueOp::Play))
}

fn queue_add(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(change_queue(ctx, args, QueueOp::Add))
}

fn queue_play_next(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(change_queue(ctx, args, QueueOp::PlayNext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{QueueTrack, RepeatMode};
    use crate::db;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::test_rig::{insert_track, mark_gone, Rig};

    fn rig() -> Rig {
        Rig::new(&[
            Capability::PlaybackRead,
            Capability::PlaybackControl,
            Capability::LibraryRead,
        ])
    }

    fn code(result: Result<Value, ApiError>) -> ApiCode {
        result.unwrap_err().code
    }

    fn ids(queue: &[QueueTrack]) -> Vec<i64> {
        queue.iter().map(|t| t.id).collect()
    }

    /// The one command sent, as a name, the queued ids and the start index.
    fn sent_one(rig: &Rig) -> (&'static str, Vec<i64>, Option<usize>) {
        let mut sent = rig.sent();
        assert_eq!(sent.len(), 1, "one command");
        match sent.remove(0) {
            PlayerCmd::Play { queue, index } => ("play", ids(&queue), Some(index)),
            PlayerCmd::Enqueue(queue) => ("add", ids(&queue), None),
            PlayerCmd::InsertNext(queue) => ("next", ids(&queue), None),
            PlayerCmd::TogglePlay => ("toggle", Vec::new(), None),
            PlayerCmd::Pause => ("pause", Vec::new(), None),
            PlayerCmd::Resume => ("resume", Vec::new(), None),
            PlayerCmd::Next => ("skip", Vec::new(), None),
            PlayerCmd::Prev => ("prev", Vec::new(), None),
            PlayerCmd::Seek(secs) => ("seek", vec![secs as i64], None),
            _ => ("other", Vec::new(), None),
        }
    }

    /// Four tracks; an album and a playlist that hold them in an order unlike their ids.
    fn stock(rig: &Rig) -> ([i64; 4], i64, i64) {
        let mut conn = rig.conn();
        let t: Vec<i64> = (0..4)
            .map(|i| insert_track(&conn, &format!("C:\\Music\\{i}.flac"), "T", "A"))
            .collect();
        let album = db::create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[t[2], t[0]],
            "album",
            1,
        )
        .unwrap()
        .id;
        let list = db::create_playlist(&conn, None, 1).unwrap().id;
        db::add_tracks_to_playlist(&mut conn, list, &[t[3], t[1], t[3]], 1).unwrap();
        ([t[0], t[1], t[2], t[3]], album, list)
    }

    #[test]
    fn queue_ops_resolve_albums_and_playlists_in_their_own_order() {
        let rig = rig();
        let (t, album, list) = stock(&rig);
        let reply = rig.call("queue.add", json!({ "album_id": album })).unwrap();
        assert_eq!(reply, json!({ "queued": 2 }));
        assert_eq!(sent_one(&rig), ("add", vec![t[2], t[0]], None));

        rig.call("queue.play_next", json!({ "playlist_id": list }))
            .unwrap();
        assert_eq!(sent_one(&rig), ("next", vec![t[3], t[1], t[3]], None));

        rig.call("queue.play", json!({ "album_id": album, "start": 1 }))
            .unwrap();
        assert_eq!(sent_one(&rig), ("play", vec![t[2], t[0]], Some(1)));

        // Gone tracks drop out of an album and of a track list; the start follows the kept tracks.
        mark_gone(&rig.conn(), t[2]);
        rig.call("queue.play", json!({ "album_id": album }))
            .unwrap();
        assert_eq!(sent_one(&rig), ("play", vec![t[0]], Some(0)));
        let args = json!({ "track_ids": [t[1], t[2], -5, 999, t[3]], "start": 2 });
        assert_eq!(rig.call("queue.play", args), Ok(json!({ "queued": 2 })));
        assert_eq!(sent_one(&rig), ("play", vec![t[1], t[3]], Some(1)));
        // A start past the end lands on the last track.
        let args = json!({ "track_ids": [t[1], t[3]], "start": 50 });
        rig.call("queue.play", args).unwrap();
        assert_eq!(sent_one(&rig), ("play", vec![t[1], t[3]], Some(1)));
    }

    #[test]
    fn nothing_to_queue_sends_nothing() {
        let rig = rig();
        let (t, _, _) = stock(&rig);
        mark_gone(&rig.conn(), t[0]);
        for method in ["queue.play", "queue.add", "queue.play_next"] {
            let reply = rig.call(method, json!({ "track_ids": [t[0], -1] }));
            assert_eq!(reply, Ok(json!({ "queued": 0 })), "{method}");
            let reply = rig.call(method, json!({ "track_ids": [] }));
            assert_eq!(reply, Ok(json!({ "queued": 0 })), "{method}");
        }
        assert!(rig.sent().is_empty());
    }

    #[test]
    fn a_queue_change_takes_at_most_500_ids() {
        let rig = rig();
        let ids: Vec<i64> = (1..=500).collect();
        assert!(rig.call("queue.add", json!({ "track_ids": ids })).is_ok());
        let ids: Vec<i64> = (1..=501).collect();
        for method in ["queue.play", "queue.add", "queue.play_next"] {
            let result = rig.call(method, json!({ "track_ids": ids }));
            assert_eq!(code(result), ApiCode::TooLarge, "{method}");
        }
        assert!(rig.sent().is_empty());
    }

    #[test]
    fn a_queue_change_names_exactly_one_known_source() {
        let rig = rig();
        let (_, album, _) = stock(&rig);
        for args in [
            json!({}),
            json!({ "album_id": album, "playlist_id": 1 }),
            json!({ "track_ids": [1], "album_id": album }),
            json!({ "album_id": "1" }),
            json!({ "playlist_id": 1.5 }),
            json!({ "track_ids": [1, "2"] }),
            json!({ "album_id": album, "start": -1 }),
        ] {
            assert_eq!(
                code(rig.call("queue.play", args.clone())),
                ApiCode::InvalidArgs,
                "{args}"
            );
        }
        assert_eq!(
            code(rig.call("queue.add", json!({ "album_id": 999 }))),
            ApiCode::NotFound
        );
        assert_eq!(
            code(rig.call("queue.add", json!({ "playlist_id": 999 }))),
            ApiCode::NotFound
        );
        // A null source counts as absent.
        assert!(rig
            .call(
                "queue.add",
                json!({ "album_id": album, "playlist_id": null })
            )
            .is_ok());
    }

    #[test]
    fn transport_methods_send_their_commands() {
        let rig = rig();
        for (method, name) in [
            ("playback.toggle", "toggle"),
            ("playback.pause", "pause"),
            ("playback.resume", "resume"),
            ("playback.next", "skip"),
            ("playback.prev", "prev"),
        ] {
            assert_eq!(rig.call(method, json!({})), Ok(json!({})));
            assert_eq!(sent_one(&rig).0, name, "{method}");
        }
        rig.call("playback.seek", json!({ "secs": 42.5 })).unwrap();
        assert_eq!(sent_one(&rig), ("seek", vec![42], None));
        for bad in [json!({}), json!({ "secs": -1 }), json!({ "secs": "3" })] {
            let result = rig.call("playback.seek", bad);
            assert_eq!(code(result), ApiCode::InvalidArgs);
        }
        assert!(rig.sent().is_empty());
    }

    #[test]
    fn a_seek_is_held_to_the_track_length() {
        let rig = rig();
        let sent_secs = |rig: &Rig| match rig.sent().remove(0) {
            PlayerCmd::Seek(secs) => secs,
            _ => panic!("not a seek"),
        };
        // Nothing loaded: the position passes through as given.
        rig.call("playback.seek", json!({ "secs": 1e300 })).unwrap();
        assert_eq!(sent_secs(&rig), 1e300);
        rig.state().player_status.lock().unwrap().duration_secs = 200.0;
        rig.call("playback.seek", json!({ "secs": 1e300 })).unwrap();
        assert_eq!(sent_secs(&rig), 200.0);
        rig.call("playback.seek", json!({ "secs": 200.0 })).unwrap();
        assert_eq!(sent_secs(&rig), 200.0);
        rig.call("playback.seek", json!({ "secs": 30.5 })).unwrap();
        assert_eq!(sent_secs(&rig), 30.5);
    }

    #[test]
    fn a_player_that_is_gone_is_unavailable() {
        let mut rig = rig();
        let (dead, _) = crossbeam_channel::unbounded();
        rig.host.app.as_mut().unwrap().player = dead;
        assert_eq!(
            code(rig.call("playback.pause", json!({}))),
            ApiCode::Unavailable
        );
    }

    #[test]
    fn the_state_names_library_tracks_only_and_no_path() {
        let rig = rig();
        let (t, _, _) = stock(&rig);
        {
            let mut status = rig.state().player_status.lock().unwrap();
            status.playing = true;
            status.track_id = Some(t[1]);
            status.position_secs = 3.0;
            status.repeat = RepeatMode::All;
            status.queue_index = 1;
            status.queue_len = 3;
            status.output_device = Some("Speakers (C:\\Device)".into());
            rig.state().player_queue.lock().unwrap().ids = vec![t[0], t[1], -4];
        }
        let state = rig.call("playback.state", json!({})).unwrap();
        assert_eq!(state["track_id"], t[1]);
        assert_eq!(state["track"]["id"], t[1]);
        assert_eq!(state["repeat"], "all");
        assert_eq!(state["queue_length"], 3);
        let mut keys: Vec<&String> = state.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "duration_secs",
                "playing",
                "position_secs",
                "queue_index",
                "queue_length",
                "repeat",
                "shuffle",
                "stream",
                "track",
                "track_id",
                "volume"
            ]
        );
        let queue = rig.call("playback.queue", json!({})).unwrap();
        assert_eq!(
            queue,
            json!({ "track_ids": [t[0], t[1], null], "index": 1 })
        );
        for text in [state.to_string(), queue.to_string()] {
            for needle in ["C:", "\\", "Music", ".flac", "Device"] {
                assert!(!text.contains(needle), "{needle} in {text}");
            }
        }

        // A track played off disk, or one gone from disk, is not described.
        rig.state().player_status.lock().unwrap().track_id = Some(-4);
        let state = rig.call("playback.state", json!({})).unwrap();
        assert_eq!(
            (state["track_id"].clone(), state["track"].clone()),
            (Value::Null, Value::Null)
        );
        mark_gone(&rig.conn(), t[1]);
        rig.state().player_status.lock().unwrap().track_id = Some(t[1]);
        let state = rig.call("playback.state", json!({})).unwrap();
        assert_eq!(state["track"], Value::Null);
    }

    #[test]
    fn the_playing_track_resolves_its_album_like_the_lists() {
        let rig = rig();
        let id = {
            let mut conn = rig.conn();
            let id = insert_track(&conn, "C:\\Music\\x.flac", "T", "A");
            let fields = (Some("Record".to_string()), Some("Band".to_string()));
            db::create_album(
                &mut conn,
                fields.0,
                fields.1,
                Some(2001),
                None,
                None,
                &[id],
                "album",
                1,
            )
            .unwrap();
            let stale = |v: &str| Some(v.to_string());
            db::set_track_edit(
                &conn,
                id,
                None,
                None,
                stale("Old"),
                stale("Guest"),
                Some(1999),
                None,
            )
            .unwrap();
            id
        };
        rig.state().player_status.lock().unwrap().track_id = Some(id);
        let state = rig.call("playback.state", json!({})).unwrap();
        assert_eq!(state["track"]["album"], "Record");
        assert_eq!(state["track"]["album_artist"], "Band");
        assert_eq!(state["track"]["year"], 2001);
    }

    #[test]
    fn reads_and_commands_need_their_own_grants() {
        let reader = Rig::new(&[Capability::PlaybackRead, Capability::LibraryRead]);
        let controller = Rig::new(&[Capability::PlaybackControl, Capability::LibraryRead]);
        for spec in METHODS {
            let (allowed, refused) = if spec.need == READ {
                (&reader, &controller)
            } else {
                (&controller, &reader)
            };
            let args = json!({ "track_ids": [], "secs": 1 });
            assert_eq!(
                code(refused.call(spec.name, args.clone())),
                ApiCode::Denied,
                "{}",
                spec.name
            );
            assert!(allowed.call(spec.name, args).is_ok(), "{}", spec.name);
        }
    }

    #[test]
    fn a_queue_change_needs_the_library_grant_as_well() {
        let control_only = Rig::new(&[Capability::PlaybackRead, Capability::PlaybackControl]);
        let library_only = Rig::new(&[Capability::LibraryRead]);
        let both = rig();
        let (t, album, list) = stock(&both);
        let (_, other_album, other_list) = stock(&control_only);
        for method in ["queue.play", "queue.add", "queue.play_next"] {
            for (args, theirs) in [
                (json!({ "track_ids": [t[0]] }), json!({ "track_ids": [t[0]] })),
                (json!({ "album_id": album }), json!({ "album_id": other_album })),
                (json!({ "playlist_id": list }), json!({ "playlist_id": other_list })),
                (json!({ "album_id": 999 }), json!({ "album_id": 999 })),
            ] {
                // Refused at admission, so an id that exists answers as a missing one does.
                assert_eq!(
                    code(control_only.call(method, theirs.clone())),
                    ApiCode::Denied,
                    "{method} {theirs}"
                );
                assert_eq!(
                    code(library_only.call(method, theirs)),
                    ApiCode::Denied,
                    "{method}"
                );
                let reply = both.call(method, args.clone());
                if args["album_id"] == 999 {
                    assert_eq!(code(reply), ApiCode::NotFound, "{method}");
                } else {
                    assert!(reply.is_ok(), "{method} {args}");
                }
            }
        }
        assert!(control_only.sent().is_empty());
        assert_eq!(both.sent().len(), 9);
    }

    #[test]
    fn a_control_only_plugin_still_drives_the_transport() {
        let rig = Rig::new(&[Capability::PlaybackControl]);
        for (method, name) in [
            ("playback.pause", "pause"),
            ("playback.next", "skip"),
            ("playback.prev", "prev"),
            ("playback.resume", "resume"),
            ("playback.toggle", "toggle"),
        ] {
            assert_eq!(rig.call(method, json!({})), Ok(json!({})), "{method}");
            assert_eq!(sent_one(&rig).0, name, "{method}");
        }
        rig.call("playback.seek", json!({ "secs": 5 })).unwrap();
        assert_eq!(sent_one(&rig), ("seek", vec![5], None));
    }

    #[test]
    fn the_table_needs_the_library_grant_exactly_for_the_queue_changes() {
        for spec in METHODS {
            let needs_library = spec.need.caps().contains(&Capability::LibraryRead);
            assert_eq!(
                needs_library,
                spec.name.starts_with("queue."),
                "{}",
                spec.name
            );
        }
    }
}

#[cfg(test)]
mod block_tests;
