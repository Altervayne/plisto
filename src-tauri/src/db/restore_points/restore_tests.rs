use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{params, Connection};

use super::tests::{add_track, names_in, rows, seed, temp_dir, walk, whole_state, ETE, MAIN};
use super::*;
use crate::db;
use crate::dto::{RestoreSummary, UnmatchedGroup, UnmatchedKind};
use crate::normalize::normalize_path_key;

// A fresh temp folder removed on drop. Declared before the connections that use it, it drops after
// them, so nothing holds a file open when the folder goes.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(tag: &str) -> Scratch {
    Scratch(temp_dir(&format!("restore_{tag}")))
}

// Takes a point of `conn` into `dir` and returns its path.
fn point_at(conn: &Connection, dir: &Path, reason: Reason, now_ms: i64) -> PathBuf {
    let taken = take(conn, dir, reason, None, now_ms).unwrap().unwrap();
    dir.join(taken.file)
}

fn apply(conn: &mut Connection, point: &Path, dir: &Path, now_ms: i64) -> Applied {
    apply_restore(conn, &load_point(point).unwrap(), dir, now_ms, |_| {}).unwrap()
}

fn plan(conn: &Connection, point: &Path) -> Result<RestoreSummary, RestoreError> {
    plan_restore(conn, &load_point(point)?)
}

fn refused(conn: &mut Connection, point: &Path, dir: &Path) -> RestoreError {
    load_point(point)
        .and_then(|loaded| apply_restore(conn, &loaded, dir, 9000, |_| {}))
        .unwrap_err()
}

fn int(v: i64) -> Value {
    Value::Integer(v)
}

// Empties every captured table and adds an album and a genre of its own, so a restore has to remove
// rows as well as bring them back.
fn wreck(conn: &Connection) {
    conn.execute_batch(
        "DELETE FROM track_visualizers; DELETE FROM track_covers; DELETE FROM track_genres;
         DELETE FROM genres; DELETE FROM track_edits; DELETE FROM playlist_tracks;
         DELETE FROM playlists; DELETE FROM album_tracks; DELETE FROM albums;
         INSERT INTO albums (id, title, created_at, updated_at) VALUES (40, 'Since', 1, 1);
         INSERT INTO genres (id, name, name_key, created_at) VALUES (7, 'Rock', 'rock', 1);",
    )
    .unwrap();
}

// ---- Round trip ----

#[test]
fn a_round_trip_restores_every_captured_row() {
    let dir = scratch("round_trip");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let before = whole_state(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    wreck(&conn);

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(whole_state(&conn), before);
    assert_eq!(
        applied.summary,
        RestoreSummary {
            albums: 1,
            singles: 1,
            playlists: 2,
            filed_tracks: 3,
            ..RestoreSummary::default()
        }
    );
    // Slots tied on position keep their order, and the album entry keeps its album.
    assert_eq!(
        rows(&conn, "SELECT id, album_id FROM playlist_tracks WHERE playlist_id = 1 ORDER BY position, id"),
        vec![
            vec![int(1), Value::Null],
            vec![int(2), int(1)],
            vec![int(3), Value::Null]
        ]
    );
    assert_eq!(
        applied.before.map(|t| t.file).as_deref(),
        Some("rp-2000-restore.sqlite")
    );
}

#[test]
fn the_plan_writes_nothing_and_matches_the_apply() {
    let dir = scratch("plan");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    wreck(&conn);
    let wrecked = whole_state(&conn);
    let changes = conn.total_changes();

    let planned = plan(&conn, &point).unwrap();
    assert_eq!(conn.total_changes(), changes);
    assert_eq!(whole_state(&conn), wrecked);
    assert_eq!(apply(&mut conn, &point, &dir.0, 2000).summary, planned);
}

// ---- Matching after library changes ----

#[test]
fn a_restore_after_a_rescan_keeps_every_row_and_counts_cleared_tracks() {
    let dir = scratch("rescan");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let before = whole_state(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);

    // A rescan refreshes scan columns in place under the same ids, and finds a new file.
    conn.execute("UPDATE tracks SET scanned_at = 99, mtime = 5", []).unwrap();
    add_track(&conn, 7, 1, &walk(MAIN, &["G.flac"]), true);
    conn.execute_batch(
        "INSERT INTO track_edits (track_id, title, updated_at) VALUES (7, 'New', 1);
         INSERT INTO track_genres (track_id, genre_id, position) VALUES (7, 1, 1);
         INSERT INTO track_visualizers (track_id, kind, updated_at) VALUES (6, 'glass', 1);
         DELETE FROM albums WHERE id = 2;",
    )
    .unwrap();

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(applied.summary.cleared_tracks, 2, "tracks 6 and 7 lose what they carry");
    assert_eq!(applied.summary.unmatched_tracks, 0);
    assert_eq!(whole_state(&conn), before);
}

#[test]
fn a_folder_removed_and_added_again_matches_by_path() {
    let dir = scratch("readd");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);

    db::remove_root(&mut conn, 1).unwrap();
    let root = db::insert_root(&conn, &normalize_path_key(MAIN), MAIN, 5).unwrap();
    assert_ne!(root, 1);
    add_track(&conn, 11, root, &walk(MAIN, &["Band", "A.flac"]), true);
    add_track(&conn, 12, root, &walk(MAIN, &["Band", "B.flac"]), true);
    add_track(&conn, 13, root, &walk(MAIN, &["C.flac"]), false);

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(applied.summary.unmatched_tracks, 0);
    assert_eq!(
        rows(&conn, "SELECT album_id, track_id, track_no, keep_own_cover FROM album_tracks ORDER BY album_id, track_id"),
        vec![
            vec![int(1), int(11), int(1), int(1)],
            vec![int(1), int(12), int(2), int(0)],
            vec![int(2), int(13), int(1), int(0)],
        ]
    );
    assert_eq!(rows(&conn, "SELECT track_id FROM track_edits"), vec![vec![int(12)]]);
    assert_eq!(rows(&conn, "SELECT track_id, cover_id FROM track_covers"), vec![vec![int(13), int(3)]]);
    assert_eq!(
        rows(&conn, "SELECT track_id, genre_id, position FROM track_genres ORDER BY track_id, genre_id"),
        vec![
            vec![int(5), int(2), int(1)],
            vec![int(11), int(1), int(1)],
            vec![int(11), int(2), int(2)],
        ]
    );
}

#[test]
fn a_moved_root_matches_by_id_through_the_recorded_move() {
    let dir = scratch("moved");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let before = whole_state(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);

    db::move_root(&mut conn, 1, "/Volumes/Disk/Main").unwrap();
    wreck(&conn);

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(applied.summary.unmatched_tracks, 0);
    assert_eq!(whole_state(&conn), before);
}

#[test]
fn a_merged_root_collapses_two_tracks_into_one() {
    let dir = scratch("merged");
    let mut conn = db::open_in_memory().unwrap();
    let (old, new) = ("/Music/Old", "/Music/New");
    let keep = db::insert_root(&conn, &normalize_path_key(old), old, 1).unwrap();
    let absorb = db::insert_root(&conn, &normalize_path_key(new), new, 1).unwrap();
    add_track(&conn, 1, keep, &walk(old, &["x.mp3"]), true);
    add_track(&conn, 2, keep, &walk(old, &["y.mp3"]), true);
    add_track(&conn, 3, absorb, &walk(new, &["x.mp3"]), true);
    add_track(&conn, 4, absorb, &walk(new, &["z.mp3"]), true);
    conn.execute_batch(
        "INSERT INTO albums (id, title, created_at, updated_at) VALUES (1, 'Kept', 1, 1), (2, 'Absorbed', 1, 1);
         INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (1, 1, 1), (1, 2, 2), (2, 3, 1), (2, 4, 2);
         INSERT INTO playlists (id, name, created_at, updated_at) VALUES (1, 'Mix', 1, 1);
         INSERT INTO playlist_tracks (id, playlist_id, track_id, position) VALUES (1, 1, 1, 1), (2, 1, 3, 2);
         INSERT INTO track_edits (track_id, title, updated_at) VALUES (1, 'one', 1), (3, 'three', 1);
         INSERT INTO track_visualizers (track_id, kind, updated_at) VALUES (3, 'glass', 1);
         INSERT INTO genres (id, name, name_key, created_at) VALUES (1, 'A', 'a', 1), (2, 'B', 'b', 1);
         INSERT INTO track_genres (track_id, genre_id, position) VALUES (1, 1, 1), (3, 2, 1), (3, 1, 2);",
    )
    .unwrap();
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);

    db::merge_root(&mut conn, keep, absorb, 5).unwrap();
    wreck(&conn);

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(applied.summary.unmatched_tracks, 0);
    assert_eq!(applied.summary.collapsed, 1);
    assert_eq!(
        rows(&conn, "SELECT album_id, track_id, track_no FROM album_tracks ORDER BY album_id, track_id"),
        vec![
            vec![int(1), int(1), int(1)],
            vec![int(1), int(2), int(2)],
            vec![int(2), int(4), int(2)],
        ]
    );
    assert_eq!(
        rows(&conn, "SELECT id, track_id FROM playlist_tracks ORDER BY id"),
        vec![vec![int(1), int(1)], vec![int(2), int(1)]],
        "both slots stay, on the one track"
    );
    assert_eq!(
        rows(&conn, "SELECT track_id, title FROM track_edits"),
        vec![vec![int(1), Value::Text("one".to_string())]]
    );
    assert_eq!(
        rows(&conn, "SELECT track_id, kind FROM track_visualizers"),
        vec![vec![int(1), Value::Text("glass".to_string())]]
    );
    assert_eq!(
        rows(&conn, "SELECT track_id, genre_id, position FROM track_genres ORDER BY position"),
        vec![vec![int(1), int(1), int(1)], vec![int(1), int(2), int(2)]],
        "genres are unioned and numbered again"
    );
}

// ---- What cannot come back ----

#[test]
fn unmatched_tracks_and_emptied_albums_are_counted() {
    let dir = scratch("unmatched");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    conn.execute_batch(
        "INSERT INTO albums (id, title, created_at, updated_at) VALUES (3, 'Empty', 1, 1);
         INSERT INTO track_edits (track_id, title, updated_at) VALUES (6, 'Six', 1);",
    )
    .unwrap();
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    db::remove_root(&mut conn, 1).unwrap();

    let planned = plan(&conn, &point).unwrap();
    assert_eq!(
        (
            planned.albums,
            planned.singles,
            planned.playlists,
            planned.filed_tracks,
            planned.unmatched_tracks,
            planned.albums_not_recreated,
            planned.dropped_entries,
            planned.collapsed
        ),
        (1, 0, 2, 0, 4, 2, 1, 0)
    );
    let kinds: Vec<(UnmatchedKind, Option<i64>, Option<&str>, usize)> = planned
        .unmatched
        .iter()
        .map(|g| (g.kind, g.id, g.title.as_deref(), g.paths.len()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (UnmatchedKind::Album, Some(1), Some("Record"), 2),
            (UnmatchedKind::Single, Some(2), Some("Lone"), 1),
            (UnmatchedKind::Other, None, None, 1),
        ]
    );
    assert_eq!(
        planned.unmatched[0],
        UnmatchedGroup {
            kind: UnmatchedKind::Album,
            id: Some(1),
            title: Some("Record".to_string()),
            paths: vec![walk(MAIN, &["Band", "A.flac"]), walk(MAIN, &["Band", "B.flac"])],
        }
    );
    assert_eq!(planned.unmatched[2].paths, vec![walk(MAIN, &["F.flac"])]);

    apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(rows(&conn, "SELECT id FROM albums"), vec![vec![int(3)]], "the empty album is recreated");
    assert_eq!(
        rows(&conn, "SELECT id, track_id FROM playlist_tracks ORDER BY id"),
        vec![vec![int(1), int(4)], vec![int(3), int(4)]],
        "the entry of an album not recreated goes"
    );
}

#[test]
fn an_unmatched_playlist_track_is_listed_under_its_playlist() {
    let dir = scratch("unmatched_playlist");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    db::remove_root(&mut conn, 2).unwrap();

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(applied.summary.unmatched_tracks, 2);
    assert_eq!(
        applied.summary.unmatched,
        vec![
            UnmatchedGroup {
                kind: UnmatchedKind::Playlist,
                id: Some(1),
                title: Some("Mix".to_string()),
                paths: vec![walk(ETE, &["Caf\u{e9}", "D.mp3"])],
            },
            UnmatchedGroup {
                kind: UnmatchedKind::Other,
                id: None,
                title: None,
                paths: vec![walk("/Elsewhere", &["E.mp3"])],
            },
        ]
    );
    assert_eq!(
        rows(&conn, "SELECT id FROM playlist_tracks"),
        vec![vec![int(2)]],
        "only the album entry is left"
    );
}

#[test]
fn covers_are_found_by_content_hash_or_dropped() {
    let dir = scratch("covers");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    // Cover 1 and cover 3 go; cover 2 comes back under another id.
    conn.execute_batch(
        "UPDATE albums SET cover_id = NULL; UPDATE playlists SET cover_id = NULL;
         DELETE FROM track_covers;
         DELETE FROM covers WHERE id IN (1, 2, 3);
         INSERT INTO covers (id, content_hash, source_kind, width, height, byte_len, created_at)
         VALUES (9, 'hash-two', 'imported', 1, 1, 1, 1);",
    )
    .unwrap();

    apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(
        rows(&conn, "SELECT id, cover_id FROM albums ORDER BY id"),
        vec![vec![int(1), Value::Null], vec![int(2), int(9)]]
    );
    assert_eq!(
        rows(&conn, "SELECT id, cover_id FROM playlists ORDER BY id"),
        vec![vec![int(1), Value::Null], vec![int(2), Value::Null]]
    );
    assert!(rows(&conn, "SELECT * FROM track_covers").is_empty());
}

// ---- Refusals ----

#[test]
fn a_newer_format_is_refused_and_nothing_changes() {
    let dir = scratch("newer");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    Connection::open(&point)
        .unwrap()
        .execute("UPDATE meta SET format = 2", [])
        .unwrap();
    wreck(&conn);
    let wrecked = whole_state(&conn);

    assert!(matches!(plan(&conn, &point), Err(RestoreError::Newer { format: 2 })));
    let err = refused(&mut conn, &point, &dir.0);
    assert!(matches!(err, RestoreError::Newer { format: 2 }));
    assert_eq!(err.refusal(), Some("newer"));
    assert_eq!(whole_state(&conn), wrecked);
    assert_eq!(names_in(&dir.0), vec!["rp-1000-daily.sqlite"], "no before-restore point");
}

#[test]
fn a_truncated_or_foreign_file_is_refused_as_unreadable() {
    let dir = scratch("truncated");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    let len = std::fs::metadata(&point).unwrap().len();
    let file = std::fs::OpenOptions::new().write(true).open(&point).unwrap();
    file.set_len(len / 2).unwrap();
    drop(file);
    let foreign = dir.0.join("rp-1-daily.sqlite");
    std::fs::write(&foreign, b"not a database").unwrap();
    wreck(&conn);
    let wrecked = whole_state(&conn);

    for bad in [&point, &foreign, &dir.0.join("rp-2-daily.sqlite")] {
        let err = refused(&mut conn, bad, &dir.0);
        assert_eq!(err.refusal(), Some("unreadable"), "{}: {err}", bad.display());
    }
    assert_eq!(whole_state(&conn), wrecked);
    assert!(names_in(&dir.0).iter().all(|n| !n.ends_with("-restore.sqlite")));
}

#[test]
fn rows_that_disagree_with_the_meta_are_refused() {
    let dir = scratch("integrity");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let counted = point_at(&conn, &dir.0, Reason::Daily, 1000);
    let hashed = point_at(&conn, &dir.0, Reason::Daily, 2000);
    Connection::open(&counted)
        .unwrap()
        .execute("DELETE FROM album_tracks WHERE track_id = 1", [])
        .unwrap();
    Connection::open(&hashed)
        .unwrap()
        .execute("UPDATE albums SET title = 'Changed' WHERE id = 1", [])
        .unwrap();
    wreck(&conn);
    let wrecked = whole_state(&conn);

    for bad in [&counted, &hashed] {
        assert_eq!(refused(&mut conn, bad, &dir.0).refusal(), Some("integrity"));
    }
    assert_eq!(whole_state(&conn), wrecked);
}

#[test]
fn a_failed_before_restore_point_refuses_and_nothing_changes() {
    let dir = scratch("before_point");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    wreck(&conn);
    let wrecked = whole_state(&conn);

    // A file where the points folder should be.
    let blocked = dir.0.join("blocked");
    std::fs::write(&blocked, b"x").unwrap();
    let mut heard = None;
    let loaded = load_point(&point).unwrap();
    let err = apply_restore(&mut conn, &loaded, &blocked, 2000, |taken| {
        heard = Some(taken.is_err());
    })
    .unwrap_err();
    assert_eq!(heard, Some(true));
    assert_eq!(err.refusal(), Some("before_point"));
    assert_eq!(whole_state(&conn), wrecked);
}

// ---- Undo and the restore ring ----

#[test]
fn restoring_the_before_restore_point_undoes_the_restore() {
    let dir = scratch("undo");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let original = whole_state(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    conn.execute_batch(
        "DELETE FROM albums WHERE id = 1;
         INSERT INTO albums (id, title, created_at, updated_at) VALUES (9, 'Later', 1, 1);
         INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (9, 1, 1), (9, 6, 2);
         UPDATE track_edits SET title = 'Retitled';
         INSERT INTO track_genres (track_id, genre_id, position) VALUES (6, 1, 1);",
    )
    .unwrap();
    let changed = whole_state(&conn);

    let restored = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(whole_state(&conn), original);
    let before = dir.0.join(restored.before.unwrap().file);
    apply(&mut conn, &before, &dir.0, 3000);
    assert_eq!(whole_state(&conn), changed);
}

#[test]
fn a_point_in_a_full_restore_ring_still_restores() {
    let dir = scratch("full_ring");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let first_state = whole_state(&conn);
    let first = point_at(&conn, &dir.0, Reason::Restore, 1);
    conn.execute("DELETE FROM albums WHERE id = 2", []).unwrap();
    point_at(&conn, &dir.0, Reason::Restore, 2);
    wreck(&conn);

    // The before-restore point fills the ring past its size, and the prune removes `first`.
    let applied = apply(&mut conn, &first, &dir.0, 3);
    assert_eq!(whole_state(&conn), first_state);
    assert_eq!(applied.before.unwrap().pruned.unwrap().removed, 1);
    assert_eq!(
        names_in(&dir.0),
        vec!["rp-2-restore.sqlite", "rp-3-restore.sqlite"]
    );
}

#[test]
fn an_empty_library_restores_without_a_before_point() {
    let dir = scratch("empty");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let before = whole_state(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    wreck(&conn);
    conn.execute_batch("DELETE FROM album_tracks; DELETE FROM albums; DELETE FROM genres;")
        .unwrap();

    let mut heard = None;
    let loaded = load_point(&point).unwrap();
    let applied = apply_restore(&mut conn, &loaded, &dir.0, 2000, |taken| {
        heard = Some(matches!(taken, Ok(None)));
    })
    .unwrap();
    assert_eq!(heard, Some(true));
    assert!(applied.before.is_none());
    assert_eq!(whole_state(&conn), before);
}

#[test]
fn a_restore_leaves_tracks_plays_and_settings_alone() {
    let dir = scratch("untouched");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    conn.execute_batch(
        "INSERT INTO plays (track_id, played_at, completed) VALUES (1, 5, 1);
         INSERT INTO settings (key, value) VALUES ('sound', 'on');
         INSERT INTO export_ledger (dest_key, rel_path, fingerprint, exported_at)
         VALUES ('/out', 'Band/A.flac', 'fp', 1);
         INSERT INTO folder_covers (folder_path, cover_id, set_at) VALUES ('/music/main/band', 4, 1);
         INSERT INTO scan_issues (path_key, path, root_id, track_id, kind, reason, detail, first_seen,
                                  last_seen)
         VALUES ('/music/main/band/b.flac', '/Music/Main/Band/B.flac', 1, 2, 'tags', 'bad', 'x', 1, 1);
         INSERT INTO duplicate_dismissals (track_lo, track_hi, dismissed_at) VALUES (1, 2, 1);",
    )
    .unwrap();
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    add_track(&conn, 7, 1, &walk(MAIN, &["G.flac"]), true);
    conn.execute("INSERT INTO plays (track_id, played_at, completed) VALUES (7, 6, 0)", params![])
        .unwrap();
    let outside = |c: &Connection| {
        (
            rows(c, "SELECT * FROM tracks ORDER BY id"),
            rows(c, "SELECT * FROM plays ORDER BY id"),
            rows(c, "SELECT * FROM settings ORDER BY key"),
            rows(c, "SELECT * FROM roots ORDER BY id"),
            rows(c, "SELECT * FROM covers ORDER BY id"),
            rows(c, "SELECT * FROM export_ledger ORDER BY dest_key, rel_path"),
            rows(c, "SELECT * FROM folder_covers ORDER BY folder_path"),
            rows(c, "SELECT * FROM scan_issues ORDER BY id"),
            rows(c, "SELECT * FROM duplicate_dismissals ORDER BY track_lo, track_hi"),
        )
    };
    let kept = outside(&conn);
    for (table, found) in [
        ("export_ledger", &kept.5),
        ("folder_covers", &kept.6),
        ("scan_issues", &kept.7),
        ("duplicate_dismissals", &kept.8),
    ] {
        assert!(!found.is_empty(), "the fixture fills {table}");
    }
    wreck(&conn);
    apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(outside(&conn), kept);
}

#[test]
fn a_write_that_fails_partway_leaves_the_library_unchanged() {
    let dir = scratch("mid_write");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    // An album entry naming an album the point does not hold: it loads, and its insert fails after
    // the earlier tables are already written.
    {
        let edit = Connection::open(&point).unwrap();
        edit.execute(
            "INSERT INTO playlist_tracks (id, playlist_id, track_id, album_id, keep_order, position)
             VALUES (50, 1, NULL, 77, 0, 9)",
            [],
        )
        .unwrap();
        let hash = super::format::content_hash(&edit, "main").unwrap();
        edit.execute("UPDATE meta SET content_hash = ?1", params![hash]).unwrap();
    }
    let loaded = load_point(&point).unwrap();
    wreck(&conn);
    let wrecked = whole_state(&conn);

    let err = apply_restore(&mut conn, &loaded, &dir.0, 2000, |_| {}).unwrap_err();
    assert_eq!(err.refusal(), None, "a failure, not a refusal: {err}");
    assert_eq!(whole_state(&conn), wrecked);
    assert!(conn.is_autocommit(), "the transaction is rolled back");
}

#[test]
fn an_album_whose_members_all_collapsed_elsewhere_is_not_recreated() {
    let dir = scratch("collapsed_album");
    let mut conn = db::open_in_memory().unwrap();
    let (old, new) = ("/Music/Old", "/Music/New");
    let keep = db::insert_root(&conn, &normalize_path_key(old), old, 1).unwrap();
    let absorb = db::insert_root(&conn, &normalize_path_key(new), new, 1).unwrap();
    add_track(&conn, 1, keep, &walk(old, &["x.mp3"]), true);
    add_track(&conn, 2, absorb, &walk(new, &["x.mp3"]), true);
    conn.execute_batch(
        "INSERT INTO albums (id, title, created_at, updated_at) VALUES (1, 'Kept', 1, 1), (2, 'Twin', 1, 1);
         INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (1, 1, 1), (2, 2, 1);
         INSERT INTO playlists (id, name, created_at, updated_at) VALUES (1, 'Mix', 1, 1);
         INSERT INTO playlist_tracks (id, playlist_id, album_id, keep_order, position)
         VALUES (1, 1, 1, 0, 1), (2, 1, 2, 1, 2);",
    )
    .unwrap();
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);
    db::merge_root(&mut conn, keep, absorb, 5).unwrap();
    wreck(&conn);

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    let s = &applied.summary;
    assert_eq!(
        (s.unmatched_tracks, s.collapsed, s.albums, s.albums_not_recreated, s.dropped_entries),
        (0, 1, 1, 1, 1)
    );
    assert!(s.unmatched.is_empty());
    assert_eq!(rows(&conn, "SELECT id FROM albums"), vec![vec![int(1)]]);
    assert_eq!(
        rows(&conn, "SELECT id, album_id FROM playlist_tracks"),
        vec![vec![int(1), int(1)]]
    );
}

#[cfg(windows)]
#[test]
fn a_folder_added_again_in_another_letter_case_matches() {
    let dir = scratch("case");
    let mut conn = db::open_in_memory().unwrap();
    seed(&conn);
    let before = whole_state(&conn);
    let point = point_at(&conn, &dir.0, Reason::Daily, 1000);

    db::remove_root(&mut conn, 1).unwrap();
    let upper = "/MUSIC/main";
    let root = db::insert_root(&conn, &normalize_path_key(upper), upper, 5).unwrap();
    add_track(&conn, 1, root, &walk(upper, &["BAND", "a.FLAC"]), true);
    add_track(&conn, 2, root, &walk(upper, &["band", "B.flac"]), true);
    add_track(&conn, 3, root, &walk(upper, &["c.flac"]), false);

    let applied = apply(&mut conn, &point, &dir.0, 2000);
    assert_eq!(applied.summary.unmatched_tracks, 0);
    assert_eq!(whole_state(&conn), before, "the same ids come back on the same files");
}
