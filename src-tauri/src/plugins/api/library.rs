/*
 * The `library.*` read methods: tracks, albums and playlists, keyset-paged (see `cursor.rs`) and
 * resolved the way Plisto shows them (see `library_rows.rs`). They only read; nothing a plugin sends
 * reaches a write. A database that cannot be read answers `unavailable`, never its error text.
 */

// -- Library Imports --
use rusqlite::Connection;
use serde_json::{json, Map, Value};

// -- Local Imports --
use super::cursor::{page_args, KeyKind, Sort, MAX_LIMIT};
use super::error::ApiError;
use super::library_rows::{
    album, album_page, playlist, playlist_page, track_page, tracks_by_id, TrackSource,
};
use super::rate::RateClass;
use super::{CallCtx, MethodSpec, Need, Outcome};
use crate::db::{ALBUM_KIND, SINGLE_KIND};
use crate::plugins::manifest::Capability;
use crate::state::AppState;

const NEED: Need = Need::Cap(Capability::LibraryRead);

pub(super) const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "library.tracks",
        need: NEED,
        class: RateClass::LibraryRead,
        run: tracks,
    },
    MethodSpec {
        name: "library.tracks_by_id",
        need: NEED,
        class: RateClass::LibraryRead,
        run: tracks_by_ids,
    },
    MethodSpec {
        name: "library.albums",
        need: NEED,
        class: RateClass::LibraryRead,
        run: albums,
    },
    MethodSpec {
        name: "library.album",
        need: NEED,
        class: RateClass::LibraryRead,
        run: one_album,
    },
    MethodSpec {
        name: "library.album_tracks",
        need: NEED,
        class: RateClass::LibraryRead,
        run: album_tracks,
    },
    MethodSpec {
        name: "library.playlists",
        need: NEED,
        class: RateClass::LibraryRead,
        run: playlists,
    },
    MethodSpec {
        name: "library.playlist",
        need: NEED,
        class: RateClass::LibraryRead,
        run: one_playlist,
    },
    MethodSpec {
        name: "library.playlist_tracks",
        need: NEED,
        class: RateClass::LibraryRead,
        run: playlist_tracks,
    },
];

const fn by_id(id_sql: &'static str) -> Sort {
    Sort {
        name: "id",
        kind: KeyKind::Id,
        key_sql: "",
        id_sql,
    }
}

const fn by_text(name: &'static str, key_sql: &'static str, id_sql: &'static str) -> Sort {
    Sort {
        name,
        kind: KeyKind::Text,
        key_sql,
        id_sql,
    }
}

const TRACK_SORTS: &[Sort] = &[
    by_id("t.id"),
    by_text(
        "title",
        "lower(COALESCE(te.title, t.raw_title, ''))",
        "t.id",
    ),
    by_text(
        "artist",
        "lower(COALESCE(te.artist, t.raw_artist, ''))",
        "t.id",
    ),
];

const ALBUM_SORTS: &[Sort] = &[
    by_id("a.id"),
    by_text("title", "lower(COALESCE(a.title, ''))", "a.id"),
    by_text("artist", "lower(COALESCE(a.album_artist, ''))", "a.id"),
];

const PLAYLIST_SORTS: &[Sort] = &[
    by_id("p.id"),
    by_text("name", "lower(COALESCE(p.name, ''))", "p.id"),
];

// Album and playlist tracks come in their container's own order only.
const ALBUM_ORDER: &[Sort] = &[Sort {
    name: "position",
    kind: KeyKind::Int,
    key_sql: "COALESCE(at.track_no, 0)",
    id_sql: "t.id",
}];

const PLAYLIST_ORDER: &[Sort] = &[Sort {
    name: "position",
    kind: KeyKind::Int,
    key_sql: "pt.position",
    id_sql: "pt.id",
}];

/// The app state behind the caller's host; `unavailable` before setup.
pub(super) fn app_state<'a>(ctx: &CallCtx<'a>) -> Result<&'a AppState, ApiError> {
    ctx.host.app_state().ok_or_else(ApiError::unavailable)
}

/// Runs `f` on the plugins' own read-only connection, so a slow page never holds the app's
/// connection. A database with no file (in-memory) has no second connection to open, so the app's is
/// used. Any database failure is `unavailable`.
pub(super) fn with_conn<R>(
    ctx: &CallCtx<'_>,
    f: impl FnOnce(&Connection) -> Result<R, ApiError>,
) -> Result<R, ApiError> {
    let state = app_state(ctx)?;
    if state.db_path.as_os_str().is_empty() {
        let conn = state.db.lock().map_err(|_| ApiError::unavailable())?;
        return f(&conn);
    }
    ctx.api.with_reader(&state.db_path, f)
}

/// Maps a database error to `unavailable`.
pub(super) fn db<T>(result: rusqlite::Result<T>) -> Result<T, ApiError> {
    result.map_err(|_| ApiError::unavailable())
}

/// The integer `id` argument.
pub(super) fn id_arg(args: &Map<String, Value>) -> Result<i64, ApiError> {
    args.get("id")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::invalid_args("'id' must be an integer."))
}

fn page_result<T: serde::Serialize>(items: Vec<T>, next: Option<String>) -> Value {
    json!({ "items": items, "next_cursor": next })
}

fn tracks(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(track_list(ctx, args, None))
}

fn album_tracks(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(id_arg(args).and_then(|id| track_list(ctx, args, Some(TrackSource::Album(id)))))
}

fn playlist_tracks(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(
        id_arg(args).and_then(|id| track_list(ctx, args, Some(TrackSource::Playlist(id)))),
    )
}

/// A page of tracks: the whole library when `source` is None, else one album or playlist, which
/// must exist.
fn track_list(
    ctx: &CallCtx<'_>,
    args: &Map<String, Value>,
    source: Option<TrackSource>,
) -> Result<Value, ApiError> {
    let (sorts, scope) = match source {
        None | Some(TrackSource::All) => (TRACK_SORTS, "tracks".to_string()),
        Some(TrackSource::Album(id)) => (ALBUM_ORDER, format!("album_tracks.{id}")),
        Some(TrackSource::Playlist(id)) => (PLAYLIST_ORDER, format!("playlist_tracks.{id}")),
    };
    let page = page_args(args, sorts, &scope)?;
    with_conn(ctx, |conn| {
        let exists = match source {
            None | Some(TrackSource::All) => true,
            Some(TrackSource::Album(id)) => db(album(conn, id))?.is_some(),
            Some(TrackSource::Playlist(id)) => db(playlist(conn, id))?.is_some(),
        };
        if !exists {
            return Err(ApiError::not_found());
        }
        let source = source.unwrap_or(TrackSource::All);
        let (items, next) = db(track_page(conn, &source, &page))?;
        Ok(page_result(items, next))
    })
}

fn tracks_by_ids(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(read_tracks_by_id(ctx, args))
}

fn read_tracks_by_id(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let ids = id_list(args, "ids", MAX_LIMIT)?;
    with_conn(ctx, |conn| {
        let items = db(tracks_by_id(conn, &ids))?;
        Ok(json!({ "items": items }))
    })
}

/// An array of integer ids named `name`, at most `cap` long.
pub(super) fn id_list(
    args: &Map<String, Value>,
    name: &'static str,
    cap: usize,
) -> Result<Vec<i64>, ApiError> {
    let Some(Value::Array(values)) = args.get(name) else {
        return Err(ApiError::invalid_args(
            "The ids must be an array of integers.",
        ));
    };
    if values.len() > cap {
        return Err(ApiError::too_large("Too many ids in one call."));
    }
    values
        .iter()
        .map(|v| {
            v.as_i64()
                .ok_or_else(|| ApiError::invalid_args("The ids must be an array of integers."))
        })
        .collect()
}

fn albums(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(album_list(ctx, args))
}

fn album_list(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Result<Value, ApiError> {
    let kind = match args.get("kind") {
        None | Some(Value::Null) => None,
        Some(Value::String(kind)) if kind == ALBUM_KIND || kind == SINGLE_KIND => {
            Some(kind.as_str())
        }
        Some(_) => {
            return Err(ApiError::invalid_args(
                "'kind' must be \"album\", \"single\" or null.",
            ))
        }
    };
    let page = page_args(args, ALBUM_SORTS, "albums")?;
    with_conn(ctx, |conn| {
        let (items, next) = db(album_page(conn, kind, &page))?;
        Ok(page_result(items, next))
    })
}

fn one_album(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(id_arg(args).and_then(|id| {
        with_conn(ctx, |conn| match db(album(conn, id))? {
            Some(found) => Ok(json!(found)),
            None => Err(ApiError::not_found()),
        })
    }))
}

fn playlists(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(
        page_args(args, PLAYLIST_SORTS, "playlists").and_then(|page| {
            with_conn(ctx, |conn| {
                let (items, next) = db(playlist_page(conn, &page))?;
                Ok(page_result(items, next))
            })
        }),
    )
}

fn one_playlist(ctx: &CallCtx<'_>, args: &Map<String, Value>) -> Outcome {
    Outcome::Done(id_arg(args).and_then(|id| {
        with_conn(ctx, |conn| match db(playlist(conn, id))? {
            Some(found) => Ok(json!(found)),
            None => Err(ApiError::not_found()),
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::plugins::api::error::ApiCode;
    use crate::plugins::api::test_rig::{insert_track, mark_gone, Rig};
    use crate::plugins::stage::Temp;

    const ROOT: &str = "D:\\Music Root";

    fn rig() -> Rig {
        Rig::new(&[Capability::LibraryRead])
    }

    fn code(result: Result<Value, ApiError>) -> ApiCode {
        result.unwrap_err().code
    }

    fn titles(page: &Value) -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["title"].as_str().unwrap_or("").to_string())
            .collect()
    }

    /// A root with three tracks: two in an album, and a playlist listing the loose one twice around
    /// the first.
    fn stock(rig: &Rig) -> (i64, i64, i64, i64, i64) {
        let mut conn = rig.conn();
        db::insert_root(&conn, "d:\\music root", ROOT, 1).unwrap();
        let a = insert_track(&conn, &format!("{ROOT}\\Band\\one.flac"), "One", "Band");
        let b = insert_track(&conn, &format!("{ROOT}\\Band\\two.flac"), "Two", "Band");
        let c = insert_track(&conn, &format!("{ROOT}\\loose.flac"), "Three", "Solo");
        let album = db::create_album(
            &mut conn,
            Some("Record".into()),
            Some("Band".into()),
            Some(2001),
            None,
            None,
            &[a, b],
            "album",
            1,
        )
        .unwrap()
        .id;
        let list = db::create_playlist(&conn, Some("Mix".into()), 1)
            .unwrap()
            .id;
        db::add_tracks_to_playlist(&mut conn, list, &[c, a, c], 1).unwrap();
        (a, b, c, album, list)
    }

    #[test]
    fn no_path_or_root_reaches_a_plugin() {
        let rig = rig();
        let (a, _, _, album, list) = stock(&rig);
        let genre = db::create_genre(&rig.conn(), "Rock", 1).unwrap();
        db::set_track_genres(&rig.conn(), a, &[genre.id]).unwrap();
        let replies = [
            rig.call("library.tracks", json!({})),
            rig.call("library.tracks", json!({ "sort": "title", "limit": 1 })),
            rig.call("library.tracks_by_id", json!({ "ids": [a] })),
            rig.call("library.albums", json!({})),
            rig.call("library.album", json!({ "id": album })),
            rig.call("library.album_tracks", json!({ "id": album })),
            rig.call("library.playlists", json!({})),
            rig.call("library.playlist", json!({ "id": list })),
            rig.call("library.playlist_tracks", json!({ "id": list, "limit": 2 })),
            rig.call("library.album", json!({ "id": 999 })),
            rig.call("library.tracks", json!({ "cursor": "v1:tracks:id::x" })),
        ];
        for reply in replies {
            let text = match reply {
                Ok(value) => value.to_string(),
                Err(error) => serde_json::to_string(&error).unwrap(),
            };
            for needle in ["Music Root", "music root", "D:", "\\", ".flac", "f.mp3"] {
                assert!(!text.contains(needle), "{needle} in {text}");
            }
        }
        let reply = rig
            .call("library.tracks_by_id", json!({ "ids": [a] }))
            .unwrap();
        let track = &reply["items"][0];
        let keys: Vec<&String> = track.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "album",
                "album_artist",
                "album_id",
                "artist",
                "disc_no",
                "duration_secs",
                "genres",
                "id",
                "title",
                "track_no",
                "year"
            ]
        );
        assert_eq!(track["genres"], json!(["Rock"]));
    }

    #[test]
    fn edits_win_over_raw_tags() {
        let rig = rig();
        let (_, _, c, _, _) = stock(&rig);
        let raw = rig
            .call("library.tracks_by_id", json!({ "ids": [c] }))
            .unwrap();
        assert_eq!(raw["items"][0]["title"], "Three");
        assert_eq!(raw["items"][0]["album"], "Raw Album");
        assert_eq!(raw["items"][0]["year"], 1990);
        db::set_track_edit(
            &rig.conn(),
            c,
            Some("Edited".into()),
            Some("Someone".into()),
            Some("Own Album".into()),
            None,
            Some(2020),
            Some(2),
        )
        .unwrap();
        let edited = rig
            .call("library.tracks_by_id", json!({ "ids": [c] }))
            .unwrap();
        let track = &edited["items"][0];
        assert_eq!(track["title"], "Edited");
        assert_eq!(track["artist"], "Someone");
        assert_eq!(track["album"], "Own Album");
        assert_eq!(track["album_artist"], "Raw AA");
        assert_eq!(track["year"], 2020);
        assert_eq!(track["disc_no"], 2);
        assert_eq!(track["album_id"], Value::Null);
    }

    #[test]
    fn an_album_member_shows_its_album_over_its_own_tags() {
        let rig = rig();
        let (a, _, _, album, _) = stock(&rig);
        let stale = |v: &str| Some(v.to_string());
        let conn = rig.conn();
        db::set_track_edit(
            &conn,
            a,
            None,
            None,
            stale("Old"),
            stale("Guest"),
            Some(1999),
            None,
        )
        .unwrap();
        drop(conn);
        // Every list and the now-playing read resolve the same way.
        let replies = [
            rig.call("library.tracks_by_id", json!({ "ids": [a] }))
                .unwrap()["items"][0]
                .clone(),
            rig.call("library.tracks", json!({})).unwrap()["items"][0].clone(),
            rig.call("library.album_tracks", json!({ "id": album }))
                .unwrap()["items"][0]
                .clone(),
        ];
        for track in replies {
            assert_eq!(track["id"], a);
            assert_eq!(track["album"], "Record");
            assert_eq!(track["album_artist"], "Band");
            assert_eq!(track["year"], 2001);
            assert_eq!(track["album_id"], album);
            assert_eq!(track["track_no"], 1);
        }
    }

    #[test]
    fn paging_is_stable_across_an_insert() {
        let rig = rig();
        for title in ["b", "d", "f", "h"] {
            insert_track(&rig.conn(), &format!("/m/{title}"), title, "x");
        }
        let first = rig
            .call("library.tracks", json!({ "sort": "title", "limit": 2 }))
            .unwrap();
        assert_eq!(titles(&first), ["b", "d"]);
        // Rows land before and after the cursor between two calls.
        for title in ["a", "c", "e"] {
            insert_track(&rig.conn(), &format!("/m/{title}"), title, "x");
        }
        let args = json!({ "sort": "title", "limit": 2, "cursor": first["next_cursor"] });
        let second = rig.call("library.tracks", args).unwrap();
        assert_eq!(titles(&second), ["e", "f"]);
        let args = json!({ "sort": "title", "limit": 2, "cursor": second["next_cursor"] });
        let last = rig.call("library.tracks", args).unwrap();
        assert_eq!(titles(&last), ["h"]);
        assert_eq!(last["next_cursor"], Value::Null);
    }

    #[test]
    fn equal_keys_page_by_id() {
        let rig = rig();
        let ids: Vec<i64> = (0..5)
            .map(|i| insert_track(&rig.conn(), &format!("/m/{i}"), "Same", "x"))
            .collect();
        let mut seen = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let args = json!({ "sort": "title", "limit": 2, "cursor": cursor });
            let page = rig.call("library.tracks", args).unwrap();
            let items = page["items"].as_array().unwrap();
            seen.extend(items.iter().map(|t| t["id"].as_i64().unwrap()));
            cursor = page["next_cursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        assert_eq!(seen, ids);
    }

    #[test]
    fn a_tampered_cursor_is_invalid_args() {
        let rig = rig();
        stock(&rig);
        let page = rig
            .call("library.tracks", json!({ "sort": "artist", "limit": 1 }))
            .unwrap();
        let cursor = page["next_cursor"].as_str().unwrap();
        assert!(cursor.starts_with("v1:tracks:artist:"));
        for args in [
            json!({ "sort": "title", "cursor": cursor }),
            json!({ "cursor": cursor }),
            json!({ "sort": "artist", "cursor": cursor.replace("v1", "v2") }),
            json!({ "sort": "artist", "cursor": format!("{cursor}0x") }),
            json!({ "sort": "artist", "cursor": "garbage" }),
        ] {
            let result = rig.call("library.tracks", args.clone());
            assert_eq!(code(result), ApiCode::InvalidArgs, "{args}");
        }
        assert_eq!(
            code(rig.call("library.playlists", json!({ "cursor": cursor }))),
            ApiCode::InvalidArgs
        );
    }

    #[test]
    fn a_cursor_only_works_on_the_list_it_came_from() {
        let rig = rig();
        let (_, _, _, album, list) = stock(&rig);
        let other = db::create_album(
            &mut rig.conn(),
            Some("Other".into()),
            None,
            None,
            None,
            None,
            &[],
            "album",
            1,
        )
        .unwrap()
        .id;
        db::create_playlist(&rig.conn(), Some("Two".into()), 1).unwrap();
        let lists = [
            ("library.tracks", json!({ "limit": 1 })),
            ("library.albums", json!({ "limit": 1 })),
            ("library.playlists", json!({ "limit": 1 })),
            ("library.album_tracks", json!({ "id": album, "limit": 1 })),
            ("library.playlist_tracks", json!({ "id": list, "limit": 1 })),
        ];
        for (from, from_args) in &lists {
            let page = rig.call(from, from_args.clone()).unwrap();
            let cursor = page["next_cursor"].as_str().unwrap();
            for (method, args) in &lists {
                let mut args = args.clone();
                args["cursor"] = json!(cursor);
                let result = rig.call(method, args);
                if method == from {
                    assert!(result.is_ok(), "{from} cursor on itself");
                } else {
                    let found = code(result);
                    assert_eq!(found, ApiCode::InvalidArgs, "{from} cursor on {method}");
                }
            }
            if *from == "library.album_tracks" {
                let args = json!({ "id": other, "cursor": cursor });
                let result = rig.call("library.album_tracks", args);
                assert_eq!(code(result), ApiCode::InvalidArgs);
            }
        }
    }

    #[test]
    fn plugin_reads_use_their_own_connection_and_see_new_rows() {
        let dir = Temp::new("api-reader");
        let path = dir.0.join("library.db");
        let rig = Rig::with_file_db(&[Capability::LibraryRead], &path);
        insert_track(&rig.conn(), "/m/a", "a", "x");
        let first = rig.call("library.tracks", json!({})).unwrap();
        assert_eq!(titles(&first), ["a"]);
        // The reader is open now; a row the app connection commits later shows on the next read.
        insert_track(&rig.conn(), "/m/b", "b", "x");
        let second = rig.call("library.tracks", json!({})).unwrap();
        assert_eq!(titles(&second), ["a", "b"]);
        // The app's connection stays free while a plugin read holds the reader.
        let held = rig.plugins.api().with_reader(&path, |_| {
            assert!(rig.state().db.try_lock().is_ok());
            Ok(())
        });
        assert!(held.is_ok());
        // The reader cannot write.
        let write = rig.plugins.api().with_reader(&path, |conn| {
            conn.execute("DELETE FROM tracks", [])
                .map(|_| ())
                .map_err(|_| ApiError::unavailable())
        });
        assert_eq!(write.unwrap_err().code, ApiCode::Unavailable);
        assert_eq!(
            rig.call("library.tracks", json!({})).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn a_reader_that_cannot_open_is_unavailable_without_a_path_and_retries() {
        let dir = Temp::new("api-reader");
        let path = dir.0.join("library.db");
        let mut rig = Rig::with_file_db(&[Capability::LibraryRead], &path);
        insert_track(&rig.conn(), "/m/a", "a", "x");
        let real = path.clone();
        rig.host.app.as_mut().unwrap().db_path = dir.0.join("missing").join("nope.db");
        let error = rig.call("library.tracks", json!({})).unwrap_err();
        assert_eq!(error.code, ApiCode::Unavailable);
        let text = serde_json::to_string(&error).unwrap();
        assert!(
            !text.contains("missing") && !text.contains("nope"),
            "{text}"
        );
        rig.host.app.as_mut().unwrap().db_path = real;
        assert!(rig.call("library.tracks", json!({})).is_ok());
    }

    #[test]
    fn gone_tracks_are_left_out_everywhere() {
        let rig = rig();
        let (a, b, c, album, list) = stock(&rig);
        mark_gone(&rig.conn(), a);
        let all = rig.call("library.tracks", json!({})).unwrap();
        assert_eq!(titles(&all), ["Two", "Three"]);
        let by_id = rig
            .call("library.tracks_by_id", json!({ "ids": [c, a, 999, b] }))
            .unwrap();
        assert_eq!(titles(&by_id), ["Three", "Two"]);
        let found = rig.call("library.album", json!({ "id": album })).unwrap();
        assert_eq!(found["track_count"], 1);
        let members = rig
            .call("library.album_tracks", json!({ "id": album }))
            .unwrap();
        assert_eq!(titles(&members), ["Two"]);
        let found = rig.call("library.playlist", json!({ "id": list })).unwrap();
        assert_eq!(found["track_count"], 2);
        let slots = rig
            .call("library.playlist_tracks", json!({ "id": list }))
            .unwrap();
        assert_eq!(titles(&slots), ["Three", "Three"]);
    }

    #[test]
    fn containers_list_their_tracks_in_their_own_order() {
        let rig = rig();
        let (_, _, _, album, list) = stock(&rig);
        let members = rig
            .call("library.album_tracks", json!({ "id": album }))
            .unwrap();
        assert_eq!(titles(&members), ["One", "Two"]);
        let first = rig
            .call("library.playlist_tracks", json!({ "id": list, "limit": 2 }))
            .unwrap();
        assert_eq!(titles(&first), ["Three", "One"]);
        let args = json!({ "id": list, "cursor": first["next_cursor"] });
        let rest = rig.call("library.playlist_tracks", args).unwrap();
        assert_eq!(titles(&rest), ["Three"]);
        let singles = rig
            .call("library.albums", json!({ "kind": "single" }))
            .unwrap();
        assert_eq!(singles["items"], json!([]));
        let albums = rig
            .call("library.albums", json!({ "sort": "title" }))
            .unwrap();
        assert_eq!(albums["items"][0]["kind"], "album");
        assert_eq!(albums["items"][0]["track_count"], 2);
        let lists = rig
            .call("library.playlists", json!({ "sort": "name" }))
            .unwrap();
        assert_eq!(lists["items"][0]["name"], "Mix");
        assert_eq!(lists["items"][0]["track_count"], 3);
    }

    #[test]
    fn unknown_containers_are_not_found_and_bad_ids_are_invalid() {
        let rig = rig();
        for method in [
            "library.album",
            "library.album_tracks",
            "library.playlist",
            "library.playlist_tracks",
        ] {
            assert_eq!(
                code(rig.call(method, json!({ "id": 5 }))),
                ApiCode::NotFound
            );
            let quoted = rig.call(method, json!({ "id": "5" }));
            assert_eq!(code(quoted), ApiCode::InvalidArgs);
            assert_eq!(code(rig.call(method, json!({}))), ApiCode::InvalidArgs);
        }
        assert_eq!(
            code(rig.call("library.albums", json!({ "kind": "ep" }))),
            ApiCode::InvalidArgs
        );
    }

    #[test]
    fn tracks_by_id_takes_at_most_200_ids() {
        let rig = rig();
        let ids: Vec<i64> = (1..=200).collect();
        assert!(rig
            .call("library.tracks_by_id", json!({ "ids": ids }))
            .is_ok());
        let ids: Vec<i64> = (1..=201).collect();
        assert_eq!(
            code(rig.call("library.tracks_by_id", json!({ "ids": ids }))),
            ApiCode::TooLarge
        );
        for bad in [json!({}), json!({ "ids": [1.5] }), json!({ "ids": "1" })] {
            let result = rig.call("library.tracks_by_id", bad);
            assert_eq!(code(result), ApiCode::InvalidArgs);
        }
    }

    #[test]
    fn the_library_needs_its_grant_and_an_app() {
        let denied = Rig::new(&[]);
        for spec in METHODS {
            let result = denied.call(spec.name, json!({ "id": 1, "ids": [1] }));
            assert_eq!(code(result), ApiCode::Denied, "{}", spec.name);
        }
        let mut rig = rig();
        rig.host.app = None;
        assert_eq!(
            code(rig.call("library.tracks", json!({}))),
            ApiCode::Unavailable
        );
    }
}
