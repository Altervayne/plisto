use std::path::Path;

use rusqlite::params;
use serde::Deserialize;

use super::*;
use crate::db;
use crate::dto::{AlbumFields, TagAlbumPlan, TagAlbumTarget};
use crate::normalize::normalize_path_key;

// Inserts a track named `title` with a raw disc tag; `missing` flags its file gone.
fn track(conn: &Connection, title: &str, disc: Option<i64>, missing: bool) -> i64 {
    conn.execute(
        "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover, scanned_at,
                             raw_title, raw_artist, raw_disc_no, missing_at)
         VALUES (?1, ?2, 'mp3', 10, 20, 0, 30, ?3, 'Artist', ?4, ?5)",
        params![
            format!("/m/{title}.mp3"),
            format!("{title}.mp3"),
            title,
            disc,
            if missing { Some(40) } else { None }
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

// Inserts an album of `kind` holding each (track, track_no) as given.
fn album(conn: &Connection, kind: &str, members: &[(i64, Option<i64>)]) -> i64 {
    conn.execute(
        "INSERT INTO albums (title, kind, created_at, updated_at) VALUES ('Record', ?1, 1, 1)",
        params![kind],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    for &(track_id, track_no) in members {
        conn.execute(
            "INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (?1, ?2, ?3)",
            params![id, track_id, track_no],
        )
        .unwrap();
    }
    id
}

fn playlist(conn: &Connection) -> i64 {
    db::create_playlist(conn, Some("Mix".into()), 1).unwrap().id
}

// Inserts one row at an explicit position: a track slot or an album entry.
fn slot(
    conn: &Connection,
    playlist_id: i64,
    track: Option<i64>,
    album: Option<i64>,
    position: i64,
) -> i64 {
    conn.execute(
        "INSERT INTO playlist_tracks (playlist_id, track_id, album_id, keep_order, position)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![playlist_id, track, album, album.is_some(), position],
    )
    .unwrap();
    conn.last_insert_rowid()
}

// One playlist row as (slot id, track, album, position).
type Row = (i64, Option<i64>, Option<i64>, i64);

// Every row of a playlist in (position, id) order.
fn rows(conn: &Connection, playlist_id: i64) -> Vec<Row> {
    conn.prepare(
        "SELECT id, track_id, album_id, position FROM playlist_tracks
         WHERE playlist_id = ?1 ORDER BY position, id",
    )
    .unwrap()
    .query_map(params![playlist_id], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    })
    .unwrap()
    .collect::<rusqlite::Result<Vec<_>>>()
    .unwrap()
}

// The track of each row, None for an album entry.
fn tracks_of(conn: &Connection, playlist_id: i64) -> Vec<Option<i64>> {
    rows(conn, playlist_id).iter().map(|r| r.1).collect()
}

fn updated_at(conn: &Connection, playlist_id: i64) -> i64 {
    conn.query_row(
        "SELECT updated_at FROM playlists WHERE id = ?1",
        params![playlist_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn track_count(conn: &Connection, playlist_id: i64) -> i64 {
    db::load_playlists(conn)
        .unwrap()
        .playlists
        .into_iter()
        .find(|p| p.id == playlist_id)
        .unwrap()
        .track_count
}

// Two discs out of order, an unset disc and track number, and a missing member. Album order is
// [d1t1, d1t2, gone, nodisc, d2t0, d2t1].
struct TwoDiscs {
    id: i64,
    order: Vec<i64>,
}

fn two_discs(conn: &Connection) -> TwoDiscs {
    let d2t1 = track(conn, "d2t1", Some(2), false);
    let d1t2 = track(conn, "d1t2", Some(1), false);
    let d1t1 = track(conn, "d1t1", Some(1), false);
    let nodisc = track(conn, "nodisc", None, false);
    let d2t0 = track(conn, "d2t0", Some(2), false);
    let gone = track(conn, "gone", Some(1), true);
    let id = album(
        conn,
        db::ALBUM_KIND,
        &[
            (d2t1, Some(1)),
            (d1t2, Some(2)),
            (d1t1, Some(1)),
            (nodisc, Some(3)),
            (d2t0, None),
            (gone, Some(2)),
        ],
    );
    TwoDiscs {
        id,
        order: vec![d1t1, d1t2, gone, nodisc, d2t0, d2t1],
    }
}

// ---- Writes ----

#[test]
fn albums_append_after_the_last_position_in_order_and_may_repeat() {
    let mut conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let b = track(&conn, "b", None, false);
    let first = album(&conn, db::ALBUM_KIND, &[(a, Some(1))]);
    let second = album(&conn, db::ALBUM_KIND, &[(b, Some(1))]);
    let list = playlist(&conn);
    db::add_tracks_to_playlist(&mut conn, list, &[a], 5).unwrap();

    add_albums_to_playlist(&mut conn, list, &[second, 999, first, second], true, 50).unwrap();

    let got = rows(&conn, list);
    let shape: Vec<(Option<i64>, Option<i64>, i64)> = got.iter().map(|r| (r.1, r.2, r.3)).collect();
    assert_eq!(
        shape,
        vec![
            (Some(a), None, 1),
            (None, Some(second), 2),
            (None, Some(first), 3),
            (None, Some(second), 4),
        ],
        "an unknown album is skipped"
    );
    let flags: Vec<bool> = db::load_playlists(&conn)
        .unwrap()
        .album_entries
        .iter()
        .map(|e| e.keep_order)
        .collect();
    assert_eq!(flags, vec![true, true, true]);
    assert_eq!(updated_at(&conn, list), 50);
}

#[test]
fn a_single_is_added_as_a_track_slot_of_its_member() {
    let mut conn = db::open_in_memory().unwrap();
    let hit = track(&conn, "hit", None, false);
    let single = album(&conn, db::SINGLE_KIND, &[(hit, Some(1))]);
    let list = playlist(&conn);

    add_albums_to_playlist(&mut conn, list, &[single], true, 50).unwrap();

    let got = rows(&conn, list);
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].1, got[0].2), (Some(hit), None));
    assert!(db::load_playlists(&conn).unwrap().album_entries.is_empty());
}

#[test]
fn an_album_of_any_other_kind_is_skipped() {
    let mut conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let b = track(&conn, "b", None, false);
    let odd = album(&conn, "compilation", &[(a, Some(1))]);
    let plain = album(&conn, db::ALBUM_KIND, &[(b, Some(1))]);
    let list = playlist(&conn);

    add_albums_to_playlist(&mut conn, list, &[odd, plain], true, 50).unwrap();

    let got = rows(&conn, list);
    assert_eq!(
        got.iter().map(|r| (r.1, r.2, r.3)).collect::<Vec<_>>(),
        vec![(None, Some(plain), 1)]
    );
}

#[test]
fn members_order_by_the_edited_disc_over_the_raw_tag() {
    let conn = db::open_in_memory().unwrap();
    let first_raw = track(&conn, "first_raw", Some(1), false);
    let second_raw = track(&conn, "second_raw", Some(2), false);
    let id = album(
        &conn,
        db::ALBUM_KIND,
        &[(first_raw, Some(1)), (second_raw, Some(1))],
    );
    conn.execute(
        "INSERT INTO track_edits (track_id, disc_no, updated_at) VALUES (?1, 3, 1)",
        params![first_raw],
    )
    .unwrap();
    let list = playlist(&conn);
    slot(&conn, list, None, Some(id), 1);

    let ids: Vec<i64> = playlist_expanded(&conn, list)
        .unwrap()
        .iter()
        .map(|r| r.track_id)
        .collect();

    assert_eq!(ids, vec![second_raw, first_raw]);
}

#[test]
fn keep_order_is_set_on_album_entries_only() {
    let mut conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let id = album(&conn, db::ALBUM_KIND, &[(a, Some(1))]);
    let list = playlist(&conn);
    let loose = slot(&conn, list, Some(a), None, 1);
    let entry = slot(&conn, list, None, Some(id), 2);

    set_entry_keep_order(&mut conn, entry, false, 60).unwrap();
    set_entry_keep_order(&mut conn, loose, true, 70).unwrap();

    let keep: Vec<bool> = conn
        .prepare("SELECT keep_order FROM playlist_tracks ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(keep, vec![false, false]);
    assert_eq!(updated_at(&conn, list), 60, "a track slot changes nothing");
}

// ---- Dissolve ----

#[test]
fn deleting_an_album_dissolves_it_in_place_in_disc_order_in_every_playlist() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = two_discs(&conn);
    let x = track(&conn, "x", None, false);
    let one = playlist(&conn);
    slot(&conn, one, Some(x), None, 1);
    slot(&conn, one, None, Some(fx.id), 2);
    slot(&conn, one, Some(x), None, 3);
    let two = playlist(&conn);
    slot(&conn, two, None, Some(fx.id), 1);

    db::delete_album(&mut conn, fx.id).unwrap();

    assert!(db::get_album(&conn, fx.id).unwrap().is_none());
    let mut want = vec![Some(x)];
    want.extend(fx.order.iter().map(|&t| Some(t)));
    want.push(Some(x));
    assert_eq!(tracks_of(&conn, one), want);
    let positions: Vec<i64> = rows(&conn, one).iter().map(|r| r.3).collect();
    assert_eq!(positions, (1..=8).collect::<Vec<_>>());
    assert_eq!(
        tracks_of(&conn, two),
        fx.order.iter().map(|&t| Some(t)).collect::<Vec<_>>()
    );
}

#[test]
fn dissolve_breaks_a_position_tie_by_slot_id_and_keeps_every_other_slot_id() {
    let mut conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let b = track(&conn, "b", None, false);
    let m1 = track(&conn, "m1", None, false);
    let m2 = track(&conn, "m2", None, false);
    let id = album(&conn, db::ALBUM_KIND, &[(m1, Some(1)), (m2, Some(2))]);
    let list = playlist(&conn);
    // Before the entry by id at the same position, and after it by id at the same position.
    let before = slot(&conn, list, Some(a), None, 3);
    let entry = slot(&conn, list, None, Some(id), 3);
    let after = slot(&conn, list, Some(b), None, 3);

    unpack_album_entry(&mut conn, entry, 80).unwrap();

    let got = rows(&conn, list);
    assert_eq!(
        got.iter().map(|r| (r.1, r.3)).collect::<Vec<_>>(),
        vec![(Some(a), 1), (Some(m1), 2), (Some(m2), 3), (Some(b), 4)]
    );
    assert_eq!(got[0].0, before);
    assert_eq!(got[3].0, after);
    assert_eq!(updated_at(&conn, list), 80);
}

#[test]
fn dissolve_of_a_last_entry_appends_its_members() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = two_discs(&conn);
    let a = track(&conn, "a", None, false);
    let list = playlist(&conn);
    slot(&conn, list, Some(a), None, 1);
    slot(&conn, list, None, Some(fx.id), 9);

    db::delete_album(&mut conn, fx.id).unwrap();

    let mut want = vec![Some(a)];
    want.extend(fx.order.iter().map(|&t| Some(t)));
    assert_eq!(tracks_of(&conn, list), want);
}

#[test]
fn the_same_album_twice_in_one_playlist_dissolves_both() {
    let conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let m1 = track(&conn, "m1", None, false);
    let m2 = track(&conn, "m2", None, false);
    let id = album(&conn, db::ALBUM_KIND, &[(m2, Some(2)), (m1, Some(1))]);
    let list = playlist(&conn);
    slot(&conn, list, None, Some(id), 1);
    slot(&conn, list, Some(a), None, 2);
    slot(&conn, list, None, Some(id), 3);

    let n = dissolve_album_entries(&conn, id).unwrap();

    assert_eq!(n, 2);
    assert_eq!(
        tracks_of(&conn, list),
        vec![Some(m1), Some(m2), Some(a), Some(m1), Some(m2)]
    );
}

#[test]
fn an_entry_of_an_album_with_no_member_dissolves_to_nothing() {
    let mut conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let empty = album(&conn, db::ALBUM_KIND, &[]);
    let list = playlist(&conn);
    slot(&conn, list, None, Some(empty), 1);
    slot(&conn, list, Some(a), None, 4);

    db::delete_album(&mut conn, empty).unwrap();

    assert_eq!(
        rows(&conn, list)
            .iter()
            .map(|r| (r.1, r.3))
            .collect::<Vec<_>>(),
        vec![(Some(a), 1)]
    );
}

#[test]
fn unpack_matches_what_a_delete_leaves() {
    let build = || {
        let conn = db::open_in_memory().unwrap();
        let fx = two_discs(&conn);
        let a = track(&conn, "a", None, false);
        let list = playlist(&conn);
        slot(&conn, list, Some(a), None, 1);
        let entry = slot(&conn, list, None, Some(fx.id), 1);
        slot(&conn, list, Some(a), None, 2);
        (conn, fx.id, list, entry)
    };
    let (mut unpacked, _, list, entry) = build();
    unpack_album_entry(&mut unpacked, entry, 80).unwrap();
    let (mut deleted, album_id, _, _) = build();
    db::delete_album(&mut deleted, album_id).unwrap();

    assert_eq!(rows(&unpacked, list), rows(&deleted, list));
}

#[test]
fn a_failure_midway_through_a_dissolve_rolls_everything_back() {
    use rusqlite::types::Value;

    let mut conn = db::open_in_memory().unwrap();
    let fx = two_discs(&conn);
    let a = track(&conn, "a", None, false);
    let list = playlist(&conn);
    slot(&conn, list, Some(a), None, 1);
    let entry = slot(&conn, list, None, Some(fx.id), 2);
    slot(&conn, list, Some(a), None, 2);
    // The third member's insert fails, after two members are already in.
    conn.execute_batch(&format!(
        "CREATE TEMP TRIGGER fail_one BEFORE INSERT ON playlist_tracks
         WHEN NEW.track_id = {} BEGIN SELECT RAISE(ABORT, 'refused'); END;",
        fx.order[2]
    ))
    .unwrap();
    let dump = |conn: &Connection| -> Vec<Vec<Value>> {
        let mut stmt = conn
            .prepare("SELECT * FROM playlist_tracks ORDER BY id")
            .unwrap();
        let cols = stmt.column_count();
        stmt.query_map([], |r| (0..cols).map(|i| r.get::<_, Value>(i)).collect())
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let before = dump(&conn);

    assert!(unpack_album_entry(&mut conn, entry, 80).is_err());
    assert_eq!(dump(&conn), before);
    assert!(db::delete_album(&mut conn, fx.id).is_err());
    assert_eq!(dump(&conn), before);
    assert!(db::get_album(&conn, fx.id).unwrap().is_some());
    assert_eq!(updated_at(&conn, list), 1);
}

#[test]
fn unpack_leaves_a_track_slot_alone() {
    let mut conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let list = playlist(&conn);
    let only = slot(&conn, list, Some(a), None, 7);

    unpack_album_entry(&mut conn, only, 80).unwrap();

    assert_eq!(rows(&conn, list), vec![(only, Some(a), None, 7)]);
    assert_eq!(updated_at(&conn, list), 1);
}

#[test]
fn a_tag_batch_undo_dissolves_the_entries_of_its_albums() {
    let mut conn = db::open_in_memory().unwrap();
    let m1 = track(&conn, "m1", None, false);
    let m2 = track(&conn, "m2", None, false);
    let plan = TagAlbumPlan {
        track_ids: vec![m1, m2],
        target: TagAlbumTarget::New {
            fields: AlbumFields {
                title: Some("T".into()),
                album_artist: None,
                year: None,
                genre: None,
            },
        },
    };
    let receipt = db::create_albums_from_tags(&mut conn, &[plan], &[None], 10).unwrap();
    let list = playlist(&conn);
    add_albums_to_playlist(&mut conn, list, &[receipt.created[0].id], true, 20).unwrap();

    db::revert_albums_from_tags(&mut conn, &receipt).unwrap();

    assert_eq!(tracks_of(&conn, list), vec![Some(m1), Some(m2)]);
}

#[test]
fn an_album_swept_for_being_empty_takes_its_entries_with_it() {
    let mut conn = db::open_in_memory().unwrap();
    let gone = track(&conn, "gone", None, true);
    let a = track(&conn, "a", None, false);
    let id = album(&conn, db::ALBUM_KIND, &[(gone, Some(1))]);
    let list = playlist(&conn);
    slot(&conn, list, Some(a), None, 1);
    slot(&conn, list, None, Some(id), 2);

    db::remove_missing_tracks(&mut conn, &[gone]).unwrap();

    assert!(db::get_album(&conn, id).unwrap().is_none());
    assert_eq!(tracks_of(&conn, list), vec![Some(a)]);
}

// ---- Readers ----

#[test]
fn track_count_is_track_slots_plus_members_of_each_entry() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = two_discs(&conn);
    let a = track(&conn, "a", None, true);
    let list = playlist(&conn);
    slot(&conn, list, Some(a), None, 1);
    slot(&conn, list, None, Some(fx.id), 2);
    slot(&conn, list, None, Some(fx.id), 3);
    let empty = playlist(&conn);

    assert_eq!(
        track_count(&conn, list),
        13,
        "missing files count, as for a slot"
    );
    assert_eq!(track_count(&conn, empty), 0);
    let created = db::create_playlist(&conn, None, 1).unwrap();
    assert_eq!(created.track_count, 0);
    db::add_tracks_to_playlist(&mut conn, created.id, &[a], 2).unwrap();
    assert_eq!(track_count(&conn, created.id), 1);
}

#[test]
fn the_snapshot_keeps_track_slots_and_entries_apart_in_play_order() {
    let mut conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let b = track(&conn, "b", None, false);
    let id = album(&conn, db::ALBUM_KIND, &[(a, Some(1))]);
    let list = playlist(&conn);
    let first = slot(&conn, list, Some(b), None, 2);
    let second = slot(&conn, list, Some(a), None, 2);
    let entry = slot(&conn, list, None, Some(id), 1);
    set_entry_keep_order(&mut conn, entry, false, 5).unwrap();

    let snapshot = db::load_playlists(&conn).unwrap();

    let slot_ids: Vec<i64> = snapshot.tracks.iter().map(|t| t.id).collect();
    assert_eq!(
        slot_ids,
        vec![first, second],
        "a position tie breaks by slot id"
    );
    assert_eq!(snapshot.album_entries.len(), 1);
    let e = &snapshot.album_entries[0];
    assert_eq!(
        (e.id, e.playlist_id, e.album_id, e.position, e.keep_order),
        (entry, list, id, 1, false)
    );
}

#[test]
fn root_removal_impact_counts_the_entries_of_albums_it_empties() {
    let conn = db::open_in_memory().unwrap();
    let root = db::insert_root(&conn, &normalize_path_key("/m"), "/m", 1).unwrap();
    let under = |title: &str| {
        let id = track(&conn, title, None, false);
        conn.execute(
            "UPDATE tracks SET root_id = ?1 WHERE id = ?2",
            params![root, id],
        )
        .unwrap();
        id
    };
    let r1 = under("r1");
    let r2 = under("r2");
    let other = track(&conn, "other", None, false);
    let emptied = album(&conn, db::ALBUM_KIND, &[(r1, Some(1))]);
    let shrunk = album(&conn, db::ALBUM_KIND, &[(r2, Some(1)), (other, Some(2))]);
    let list = playlist(&conn);
    slot(&conn, list, Some(r1), None, 1);
    slot(&conn, list, None, Some(emptied), 2);
    slot(&conn, list, None, Some(emptied), 3);
    slot(&conn, list, None, Some(shrunk), 4);
    slot(&conn, list, Some(other), None, 5);

    let impact = db::root_removal_impact(&conn, root).unwrap();

    assert_eq!(
        impact.playlist_entries, 3,
        "one track slot and two entries of the emptied album"
    );
}

#[test]
fn track_slot_readers_never_see_an_entry() {
    let conn = db::open_in_memory().unwrap();
    let a = track(&conn, "a", None, false);
    let id = album(&conn, db::ALBUM_KIND, &[(a, Some(1))]);
    let list = playlist(&conn);
    slot(&conn, list, None, Some(id), 1);

    assert!(db::load_playlists(&conn).unwrap().tracks.is_empty());
}

// ---- Export ----

// A playlist of a loose track, then a two-member album entry, then the loose track again.
fn export_fixture(conn: &mut Connection) -> (i64, i64, [i64; 3]) {
    let loose = track(conn, "loose", None, false);
    let m1 = track(conn, "m1", None, false);
    let m2 = track(conn, "m2", None, false);
    let id = db::create_album(
        conn,
        Some("Rec".into()),
        Some("AA".into()),
        None,
        None,
        None,
        &[m1, m2],
        db::ALBUM_KIND,
        1,
    )
    .unwrap()
    .id;
    let list = playlist(conn);
    db::add_tracks_to_playlist(conn, list, &[loose], 2).unwrap();
    add_albums_to_playlist(conn, list, &[id], true, 3).unwrap();
    db::add_tracks_to_playlist(conn, list, &[loose, m1], 4).unwrap();
    (list, id, [loose, m1, m2])
}

fn m3u(conn: &Connection, list: i64) -> String {
    let plan = crate::export::playlist_export_plan(conn, list).unwrap();
    crate::export::render_m3u(&plan, |t| t.source_path.clone())
}

#[test]
fn the_m3u_lists_an_entry_as_its_members_in_album_order() {
    let mut conn = db::open_in_memory().unwrap();
    let (list, _, [loose, m1, m2]) = export_fixture(&mut conn);

    let plan = crate::export::playlist_export_plan(&conn, list).unwrap();

    let ids: Vec<i64> = plan.tracks.iter().map(|t| t.track_id).collect();
    assert_eq!(ids, vec![loose, m1, m2, loose, m1]);
    let paths: Vec<String> = m3u(&conn, list)
        .lines()
        .filter(|l| !l.starts_with('#'))
        .map(str::to_string)
        .collect();
    assert_eq!(
        paths,
        vec![
            "/m/loose.mp3",
            "/m/m1.mp3",
            "/m/m2.mp3",
            "/m/loose.mp3",
            "/m/m1.mp3"
        ]
    );
}

#[test]
fn the_folder_export_copies_each_track_once() {
    let mut conn = db::open_in_memory().unwrap();
    let (list, album_id, [loose, m1, m2]) = export_fixture(&mut conn);

    let plan = crate::export::playlist_folder_plan(&conn, list).unwrap();

    let all: Vec<i64> = plan
        .containers
        .iter()
        .flat_map(|c| c.tracks.iter().map(|t| t.track_id))
        .collect();
    for id in [loose, m1, m2] {
        assert_eq!(
            all.iter().filter(|&&t| t == id).count(),
            1,
            "track {id} is one file"
        );
    }
    let members: Vec<i64> = plan
        .containers
        .iter()
        .find(|c| c.album_id == album_id)
        .unwrap()
        .tracks
        .iter()
        .map(|t| t.track_id)
        .collect();
    assert_eq!(
        members,
        vec![m1, m2],
        "an entry's members export through their album"
    );
}

#[test]
fn a_mimic_album_numbers_the_expanded_tracks_in_play_order() {
    let mut conn = db::open_in_memory().unwrap();
    let (list, _, [loose, m1, m2]) = export_fixture(&mut conn);

    let plan = crate::export::mimic_album_plan(&conn, list).unwrap();

    let numbered: Vec<(i64, Option<i64>)> = plan.containers[0]
        .tracks
        .iter()
        .map(|t| (t.track_id, t.track_no))
        .collect();
    assert_eq!(
        numbered,
        vec![(loose, Some(1)), (m1, Some(2)), (m2, Some(3))]
    );
}

#[test]
fn reordering_a_referenced_album_changes_the_rendered_playlist() {
    let mut conn = db::open_in_memory().unwrap();
    let (list, album_id, [_, m1, m2]) = export_fixture(&mut conn);
    let before = m3u(&conn, list);

    db::set_member_placement(&mut conn, album_id, m1, Some(3), false).unwrap();

    let after = m3u(&conn, list);
    assert_ne!(
        after, before,
        "the ledger fingerprints these bytes, so the file reads changed"
    );
    let plan = crate::export::playlist_export_plan(&conn, list).unwrap();
    let ids: Vec<i64> = plan.tracks.iter().map(|t| t.track_id).collect();
    assert_eq!(&ids[1..3], &[m2, m1]);
}

// ---- Golden fixture ----

// The expansion fixture the frontend's playlist expansion reads too.
const FIXTURE: &str = "../src/components/playlists/playlistExpand.fixture.json";

#[derive(Deserialize)]
struct Fixture {
    albums: Vec<FixtureAlbum>,
    loose_tracks: Vec<FixtureTrack>,
    playlist: FixturePlaylist,
    track_count: i64,
    expected: Vec<FixtureExpected>,
}

#[derive(Deserialize)]
struct FixtureAlbum {
    id: i64,
    kind: String,
    members: Vec<FixtureMember>,
}

#[derive(Deserialize)]
struct FixtureMember {
    track_id: i64,
    disc_no: Option<i64>,
    track_no: Option<i64>,
    missing: bool,
}

#[derive(Deserialize)]
struct FixtureTrack {
    track_id: i64,
    missing: bool,
}

#[derive(Deserialize)]
struct FixturePlaylist {
    id: i64,
    slots: Vec<FixtureSlot>,
}

#[derive(Deserialize)]
struct FixtureSlot {
    id: i64,
    position: i64,
    track_id: Option<i64>,
    album_id: Option<i64>,
    #[serde(default)]
    keep_order: bool,
}

#[derive(Deserialize)]
struct FixtureExpected {
    present_only: bool,
    ids: Vec<i64>,
    blocks: Vec<[usize; 2]>,
}

fn fixture_track(conn: &Connection, id: i64, disc: Option<i64>, missing: bool) {
    conn.execute(
        "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, has_embedded_cover,
                             scanned_at, raw_disc_no, missing_at)
         VALUES (?1, ?2, 'song.mp3', 'mp3', 10, 20, 0, 30, ?3, ?4)",
        params![
            id,
            format!("/m/{id}.mp3"),
            disc,
            if missing { Some(40) } else { None }
        ],
    )
    .unwrap();
}

#[test]
fn the_golden_fixture_expands_as_written() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("the fixture {} must exist ({e})", path.display()));
    let fx: Fixture = serde_json::from_str(&text).unwrap();

    let conn = db::open_in_memory().unwrap();
    for t in &fx.loose_tracks {
        fixture_track(&conn, t.track_id, None, t.missing);
    }
    for a in &fx.albums {
        conn.execute(
            "INSERT INTO albums (id, kind, created_at, updated_at) VALUES (?1, ?2, 1, 1)",
            params![a.id, a.kind],
        )
        .unwrap();
        for m in &a.members {
            fixture_track(&conn, m.track_id, m.disc_no, m.missing);
            conn.execute(
                "INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (?1, ?2, ?3)",
                params![a.id, m.track_id, m.track_no],
            )
            .unwrap();
        }
    }
    conn.execute(
        "INSERT INTO playlists (id, created_at, updated_at) VALUES (?1, 1, 1)",
        params![fx.playlist.id],
    )
    .unwrap();
    for s in &fx.playlist.slots {
        conn.execute(
            "INSERT INTO playlist_tracks (id, playlist_id, track_id, album_id, keep_order, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![s.id, fx.playlist.id, s.track_id, s.album_id, s.keep_order, s.position],
        )
        .unwrap();
    }

    let rows = playlist_expanded(&conn, fx.playlist.id).unwrap();
    assert_eq!(fx.expected.len(), 2);
    for want in &fx.expected {
        let (ids, blocks) = expanded_queue(&rows, want.present_only);
        assert_eq!(ids, want.ids, "ids, present_only {}", want.present_only);
        assert_eq!(
            blocks, want.blocks,
            "blocks, present_only {}",
            want.present_only
        );
    }
    assert_eq!(track_count(&conn, fx.playlist.id), fx.track_count);
}
