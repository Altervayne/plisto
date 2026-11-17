// -- Library Imports --
use rusqlite::params;
use serde_json::{json, Value};

// -- Local Imports --
use crate::db;
use crate::plugins::api::cursor::COMPOSITE_DIGITS;
use crate::plugins::api::error::ApiCode;
use crate::plugins::api::test_rig::{insert_track, mark_gone, Rig};
use crate::plugins::manifest::Capability;

fn rig() -> Rig {
    Rig::new(&[Capability::LibraryRead])
}

fn ids(page: &Value) -> Vec<i64> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].as_i64().unwrap())
        .collect()
}

/// A playlist: loose track `x`, an album entry of `members` (disc 2 filed before disc 1, so album
/// order differs from id order), then loose track `y`.
struct Mix {
    list: i64,
    album: i64,
    x: i64,
    y: i64,
    members: Vec<i64>,
}

impl Mix {
    /// Every track the playlist plays, in order.
    fn played(&self) -> Vec<i64> {
        let mut all = vec![self.x];
        all.extend(&self.members);
        all.push(self.y);
        all
    }
}

fn mix(rig: &Rig, keep_order: bool) -> Mix {
    let mut conn = rig.conn();
    let folder = if keep_order { "kept" } else { "loose" };
    let track = |n: &str| insert_track(&conn, &format!("/m/{folder}/{n}.flac"), n, "A");
    let (x, y) = (track("x"), track("y"));
    let filed: Vec<i64> = ["d2t1", "d1t1", "d1t2"].iter().map(|n| track(n)).collect();
    let album = db::create_album(
        &mut conn,
        Some("Record".into()),
        None,
        None,
        None,
        None,
        &filed,
        "album",
        1,
    )
    .unwrap()
    .id;
    for (id, disc, no) in [(filed[0], 2, 1), (filed[1], 1, 1), (filed[2], 1, 2)] {
        conn.execute(
            "UPDATE tracks SET raw_disc_no = ?2 WHERE id = ?1",
            params![id, disc],
        )
        .unwrap();
        conn.execute(
            "UPDATE album_tracks SET track_no = ?2 WHERE track_id = ?1",
            params![id, no],
        )
        .unwrap();
    }
    let list = db::create_playlist(&conn, Some("Mix".into()), 1)
        .unwrap()
        .id;
    db::add_tracks_to_playlist(&mut conn, list, &[x], 1).unwrap();
    db::add_albums_to_playlist(&mut conn, list, &[album], keep_order, 1).unwrap();
    db::add_tracks_to_playlist(&mut conn, list, &[y], 1).unwrap();
    Mix {
        list,
        album,
        x,
        y,
        members: vec![filed[1], filed[2], filed[0]],
    }
}

/// The (slot id, position) of each slot, in playlist order.
fn slots(rig: &Rig, list: i64) -> Vec<(i64, i64)> {
    let conn = rig.conn();
    let mut stmt = conn
        .prepare(
            "SELECT id, position FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position, id",
        )
        .unwrap();
    let rows = stmt
        .query_map(params![list], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows
}

/// Every track of the playlist read page by page from `cursor`, with the next cursor of each page.
fn read_from(rig: &Rig, list: i64, limit: usize, mut cursor: Value) -> Vec<i64> {
    let mut seen = Vec::new();
    loop {
        let args = json!({ "id": list, "limit": limit, "cursor": cursor });
        let page = rig.call("library.playlist_tracks", args).unwrap();
        seen.extend(ids(&page));
        cursor = page["next_cursor"].clone();
        if cursor.is_null() {
            return seen;
        }
    }
}

#[test]
fn playlist_tracks_play_an_album_entry_as_its_members_in_album_order() {
    let rig = rig();
    let fx = mix(&rig, true);
    let page = rig
        .call("library.playlist_tracks", json!({ "id": fx.list }))
        .unwrap();
    assert_eq!(ids(&page), fx.played());
    // Same item shape as a library track.
    assert_eq!(page["items"][1]["album_id"], fx.album);
    assert_eq!(page["items"][1]["album"], "Record");
    let found = rig
        .call("library.playlist", json!({ "id": fx.list }))
        .unwrap();
    assert_eq!(found["track_count"], 5);
    let listed = rig.call("library.playlists", json!({})).unwrap();
    assert_eq!(listed["items"][0]["track_count"], 5);

    // A missing member drops out of the tracks and the count, and the entry stays.
    mark_gone(&rig.conn(), fx.members[1]);
    let page = rig
        .call("library.playlist_tracks", json!({ "id": fx.list }))
        .unwrap();
    assert_eq!(ids(&page), [fx.x, fx.members[0], fx.members[2], fx.y]);
    let found = rig
        .call("library.playlist", json!({ "id": fx.list }))
        .unwrap();
    assert_eq!(found["track_count"], 4);
}

#[test]
fn paging_across_an_entry_skips_and_repeats_nothing() {
    let rig = rig();
    let fx = mix(&rig, false);
    for limit in [1, 2, 3] {
        assert_eq!(
            read_from(&rig, fx.list, limit, Value::Null),
            fx.played(),
            "limit {limit}"
        );
    }
    let first = rig
        .call(
            "library.playlist_tracks",
            json!({ "id": fx.list, "limit": 2 }),
        )
        .unwrap();
    let cursor = first["next_cursor"].as_str().unwrap();
    let key = cursor.split(':').nth(3).unwrap();
    assert!(cursor.starts_with(&format!("v1:playlist_tracks.{}:position:", fx.list)));
    assert_eq!(key.len(), COMPOSITE_DIGITS, "{cursor}");
}

#[test]
fn a_member_added_between_calls_skips_and_repeats_nothing() {
    let rig = rig();
    let fx = mix(&rig, true);
    let first = rig
        .call(
            "library.playlist_tracks",
            json!({ "id": fx.list, "limit": 2 }),
        )
        .unwrap();
    assert_eq!(ids(&first), [fx.x, fx.members[0]]);
    // One new member lands behind the cursor, one ahead of it.
    let early = insert_track(&rig.conn(), "/m/early.flac", "early", "A");
    let late = insert_track(&rig.conn(), "/m/late.flac", "late", "A");
    db::add_tracks_to_album(&mut rig.conn(), fx.album, &[early, late]).unwrap();
    for (id, disc, no) in [(early, 1, 0), (late, 2, 2)] {
        let conn = rig.conn();
        conn.execute(
            "UPDATE tracks SET raw_disc_no = ?2 WHERE id = ?1",
            params![id, disc],
        )
        .unwrap();
        conn.execute(
            "UPDATE album_tracks SET track_no = ?2 WHERE track_id = ?1",
            params![id, no],
        )
        .unwrap();
    }
    let rest = read_from(&rig, fx.list, 2, first["next_cursor"].clone());
    assert_eq!(rest, [fx.members[1], fx.members[2], late, fx.y]);
}

#[test]
fn a_cursor_from_before_album_entries_continues_after_its_slot() {
    let rig = rig();
    let fx = mix(&rig, true);
    let slots = slots(&rig, fx.list);
    let legacy = |(slot, position): (i64, i64)| {
        json!(format!(
            "v1:playlist_tracks.{}:position:{position}:{slot}",
            fx.list
        ))
    };
    // After the track slot of x: the whole entry follows.
    let from_track = read_from(&rig, fx.list, 2, legacy(slots[0]));
    assert_eq!(from_track, &fx.played()[1..]);
    // After the album entry's slot: none of its members repeat.
    let from_entry = read_from(&rig, fx.list, 2, legacy(slots[1]));
    assert_eq!(from_entry, [fx.y]);
}

#[test]
fn a_tampered_playlist_cursor_is_invalid_args() {
    let rig = rig();
    let fx = mix(&rig, true);
    let first = rig
        .call(
            "library.playlist_tracks",
            json!({ "id": fx.list, "limit": 2 }),
        )
        .unwrap();
    let cursor = first["next_cursor"].as_str().unwrap().to_string();
    let key = cursor.split(':').nth(3).unwrap().to_string();
    let with_key = |k: &str| cursor.replacen(&key, k, 1);
    for bad in [
        with_key(&key[1..]),
        with_key(&format!("{key}0")),
        with_key(&format!("+{}", &key[1..])),
        with_key(&format!("-{}", &key[1..])),
        with_key("99999999999999999999"),
        with_key("x"),
    ] {
        let result = rig.call(
            "library.playlist_tracks",
            json!({ "id": fx.list, "cursor": bad }),
        );
        assert_eq!(result.unwrap_err().code, ApiCode::InvalidArgs, "{bad}");
    }
    // A composite cursor belongs to its playlist.
    let other = db::create_playlist(&rig.conn(), None, 1).unwrap().id;
    let result = rig.call(
        "library.playlist_tracks",
        json!({ "id": other, "cursor": cursor }),
    );
    assert_eq!(result.unwrap_err().code, ApiCode::InvalidArgs);
}

#[test]
fn playlist_entries_list_each_entry_once_and_leave_out_missing_tracks() {
    let rig = rig();
    let fx = mix(&rig, true);
    let unkept = mix(&rig, false);
    let slots = slots(&rig, fx.list);
    let whole = rig
        .call("library.playlist_entries", json!({ "id": fx.list }))
        .unwrap();
    assert_eq!(
        whole,
        json!({
            "items": [
                { "entry_id": slots[0].0, "kind": "track", "id": fx.x, "keep_order": false },
                { "entry_id": slots[1].0, "kind": "album", "id": fx.album, "keep_order": true },
                { "entry_id": slots[2].0, "kind": "track", "id": fx.y, "keep_order": false },
            ],
            "next_cursor": null,
        })
    );
    let other = rig
        .call("library.playlist_entries", json!({ "id": unkept.list }))
        .unwrap();
    assert_eq!(other["items"][1]["keep_order"], false);

    // One a page; a missing track's entry is left out, the album entry stays.
    mark_gone(&rig.conn(), fx.y);
    let mut seen = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let args = json!({ "id": fx.list, "limit": 1, "cursor": cursor });
        let page = rig.call("library.playlist_entries", args).unwrap();
        seen.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["entry_id"].as_i64().unwrap()),
        );
        cursor = page["next_cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(seen, [slots[0].0, slots[1].0]);
}

#[test]
fn playlist_entries_check_the_playlist_and_the_cursor() {
    let rig = rig();
    let fx = mix(&rig, true);
    let code = |args: Value| rig.call("library.playlist_entries", args).unwrap_err().code;
    assert_eq!(code(json!({ "id": 999 })), ApiCode::NotFound);
    assert_eq!(code(json!({ "id": "1" })), ApiCode::InvalidArgs);
    assert_eq!(code(json!({})), ApiCode::InvalidArgs);
    assert_eq!(
        code(json!({ "id": fx.list, "sort": "id" })),
        ApiCode::InvalidArgs
    );
    let page = rig
        .call(
            "library.playlist_entries",
            json!({ "id": fx.list, "limit": 1 }),
        )
        .unwrap();
    let cursor = page["next_cursor"].as_str().unwrap();
    assert!(cursor.starts_with(&format!("v1:playlist_entries.{}:position:", fx.list)));
    // An entries cursor and a tracks cursor never cross.
    let crossed = rig.call(
        "library.playlist_tracks",
        json!({ "id": fx.list, "cursor": cursor }),
    );
    assert_eq!(crossed.unwrap_err().code, ApiCode::InvalidArgs);
    let tracks = rig
        .call(
            "library.playlist_tracks",
            json!({ "id": fx.list, "limit": 1 }),
        )
        .unwrap();
    let crossed = rig.call(
        "library.playlist_entries",
        json!({ "id": fx.list, "cursor": tracks["next_cursor"] }),
    );
    assert_eq!(crossed.unwrap_err().code, ApiCode::InvalidArgs);
}

/// An unpack renumbers the playlist, so a cursor taken inside the entry no longer names a stable
/// place: the read goes on with valid pages, and the member the cursor named comes again from its new
/// slot.
#[test]
fn an_unpack_between_calls_still_reads_valid_pages() {
    let rig = rig();
    let fx = mix(&rig, true);
    let first = rig
        .call(
            "library.playlist_tracks",
            json!({ "id": fx.list, "limit": 2 }),
        )
        .unwrap();
    assert_eq!(ids(&first), [fx.x, fx.members[0]]);
    let entry = slots(&rig, fx.list)[1].0;
    db::unpack_album_entry(&mut rig.conn(), entry, 2).unwrap();
    let rest = read_from(&rig, fx.list, 2, first["next_cursor"].clone());
    let mut expected = fx.members.clone();
    expected.push(fx.y);
    assert_eq!(rest, expected);
}
