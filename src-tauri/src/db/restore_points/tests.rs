use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use rusqlite::types::Value;
use rusqlite::{params, Connection, OpenFlags};

use super::format::{track_paths, DATA_TABLES, EXCLUDED_COLUMNS, EXCLUDED_TABLES};
use super::take::{claim_names, point_dir, take_job, Job};
use super::*;
use crate::db;
use crate::normalize::normalize_path_key;

pub(super) fn temp_dir(tag: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "plisto_rp_{tag}_{}_{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// The names in `dir`, sorted.
pub(super) fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn open_point(path: &Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

pub(super) fn rows(conn: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let cols = stmt.column_count();
    stmt.query_map([], |r| (0..cols).map(|i| r.get::<_, Value>(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn ids(conn: &Connection, sql: &str) -> Vec<i64> {
    let mut stmt = conn.prepare(sql).unwrap();
    let ids = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    ids
}

// Every captured table, every column as stored, in key order.
pub(super) fn whole_state(conn: &Connection) -> Vec<Vec<Vec<Value>>> {
    DATA_TABLES
        .iter()
        .map(|t| rows(conn, &format!("SELECT * FROM {} ORDER BY {}", t.name, t.key)))
        .collect()
}

pub(super) const MAIN: &str = "/Music/Main";
pub(super) const ETE: &str = "/Musique/\u{c9}t\u{e9}";

// The real-case path a walk of `root` yields for the file at `parts` below it.
pub(super) fn walk(root: &str, parts: &[&str]) -> String {
    parts
        .iter()
        .fold(PathBuf::from(root), |p, c| p.join(c))
        .to_string_lossy()
        .into_owned()
}

// Inserts a track keyed the way a scan keys `display`; `display_kept` false leaves a legacy row with
// no display path.
pub(super) fn add_track(conn: &Connection, id: i64, root_id: i64, display: &str, display_kept: bool) {
    conn.execute(
        "INSERT INTO tracks (id, source_path, display_path, filename, ext, size_bytes, mtime,
                             duration_secs, has_embedded_cover, scanned_at, root_id)
         VALUES (?1, ?2, ?3, 'x.flac', 'flac', ?4, 1, ?5, 0, 1, ?6)",
        params![
            id,
            normalize_path_key(display),
            display_kept.then_some(display),
            100 + id,
            179.5 + id as f64,
            root_id
        ],
    )
    .unwrap();
}

// A library with a row in every captured table and a value in every captured column, plus track 6
// and cover 4, which nothing references. Track 3 has no display path and track 5 sits outside its
// root.
pub(super) fn seed(conn: &Connection) {
    conn.execute_batch(
        "INSERT INTO roots (id, root_key, path, added_at) VALUES
            (1, '/music/main', '/Music/Main', 1),
            (2, '/musique/\u{e9}t\u{e9}', '/Musique/\u{c9}t\u{e9}', 1);",
    )
    .unwrap();
    add_track(conn, 1, 1, &walk(MAIN, &["Band", "A.flac"]), true);
    add_track(conn, 2, 1, &walk(MAIN, &["Band", "B.flac"]), true);
    add_track(conn, 3, 1, &walk(MAIN, &["C.flac"]), false);
    add_track(conn, 4, 2, &walk(ETE, &["Caf\u{e9}", "D.mp3"]), true);
    add_track(conn, 5, 2, &walk("/Elsewhere", &["E.mp3"]), true);
    add_track(conn, 6, 1, &walk(MAIN, &["F.flac"]), true);
    conn.execute_batch(
        "INSERT INTO covers (id, content_hash, source_kind, width, height, byte_len, created_at) VALUES
            (1, 'hash-one', 'imported', 1, 1, 1, 1),
            (2, 'hash-two', 'imported', 1, 1, 1, 1),
            (3, 'hash-three', 'imported', 1, 1, 1, 1),
            (4, 'hash-four', 'imported', 1, 1, 1, 1);
         INSERT INTO albums (id, title, album_artist, year, genre, cover_id, created_at, updated_at,
                             kind, visualizer) VALUES
            (1, 'Record', 'Band', 1999, 'Rock', 1, 10, 11, 'album', 'ridge'),
            (2, 'Lone', 'Solo', 2001, 'Pop', 2, 12, 13, 'single', NULL);
         INSERT INTO album_tracks (album_id, track_id, track_no, keep_own_cover) VALUES
            (1, 1, 1, 1), (1, 2, 2, 0), (2, 3, 1, 0);
         INSERT INTO playlists (id, name, created_at, updated_at, description, cover_id) VALUES
            (1, 'Mix', 20, 21, 'Late night', 3),
            (2, NULL, 22, 23, NULL, NULL);
         INSERT INTO playlist_tracks (id, playlist_id, track_id, album_id, keep_order, position) VALUES
            (1, 1, 4, NULL, 0, 1),
            (2, 1, NULL, 1, 1, 2),
            (3, 1, 4, NULL, 0, 2);
         INSERT INTO track_edits (track_id, title, artist, album, album_artist, year, disc_no,
                                  updated_at) VALUES
            (2, 'Title', 'Artist', 'Album', 'Album Artist', 2000, 2, 30);
         INSERT INTO genres (id, name, name_key, created_at) VALUES
            (1, 'Rock', 'rock', 40), (2, '\u{c9}lectro', '\u{e9}lectro', 41);
         INSERT INTO track_genres (track_id, genre_id, position) VALUES
            (1, 1, 1), (1, 2, 2), (5, 2, 1);
         INSERT INTO track_covers (track_id, cover_id, created_at) VALUES (3, 3, 50);
         INSERT INTO track_visualizers (track_id, kind, updated_at) VALUES (4, 'glass', 60);",
    )
    .unwrap();
}

// A track's identity as (id, root id, real-case path, key, size, duration).
type Identity = (i64, Option<i64>, String, String, i64, Option<f64>);

// The point's identity rows, paths rebuilt the way a restore reads them.
fn identities(point: &Connection) -> Vec<Identity> {
    let mut stmt = point
        .prepare(
            "SELECT t.id, t.root_id, r.path, t.rel_path, t.path_key, t.size_bytes, t.duration_secs
             FROM tracks t LEFT JOIN roots r ON r.id = t.root_id ORDER BY t.id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            let root: Option<String> = r.get(2)?;
            let rel: String = r.get(3)?;
            let key: Option<String> = r.get(4)?;
            let (display, key) = track_paths(root.as_deref(), &rel, key.as_deref());
            Ok((r.get(0)?, r.get(1)?, display, key, r.get(5)?, r.get(6)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows
}

// The referenced live tracks in the same shape.
fn live_identities(conn: &Connection) -> Vec<Identity> {
    let mut stmt = conn
        .prepare(
            "SELECT id, root_id, COALESCE(display_path, source_path), source_path, size_bytes,
                    duration_secs
             FROM tracks WHERE id <> 6 ORDER BY id",
        )
        .unwrap();
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    rows
}

fn take_at(conn: &Connection, dir: &Path, reason: Reason, now_ms: i64) -> Taken {
    take(conn, dir, reason, None, now_ms).unwrap().unwrap()
}

// ---- Content ----

#[test]
fn a_point_round_trips_every_captured_table() {
    let dir = temp_dir("round_trip");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    for table in DATA_TABLES {
        for column in table.columns {
            let set: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {} WHERE {column} IS NOT NULL", table.name),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(set > 0, "the fixture sets {}.{column}", table.name);
        }
    }

    let taken = take_at(&conn, &dir, Reason::Daily, 1000);
    assert_eq!(taken.file, "rp-1000-daily.sqlite");
    let point = open_point(&dir.join(&taken.file));
    assert_eq!(whole_state(&point), whole_state(&conn));
    assert_eq!(
        rows(&point, "SELECT id, path, root_key FROM roots ORDER BY id"),
        rows(&conn, "SELECT id, path, root_key FROM roots ORDER BY id")
    );
    assert_eq!(identities(&point), live_identities(&conn));
    let full_form = ids(&point, "SELECT id FROM tracks WHERE path_key IS NOT NULL ORDER BY id");
    assert!(full_form.contains(&5), "a track outside its root keeps its whole path");
    for id in [1, 2, 4] {
        assert!(!full_form.contains(&id), "track {id} is stored below its root");
    }
    drop(point);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn identity_rows_cover_only_what_the_point_references() {
    let dir = temp_dir("identity");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    let taken = take_at(&conn, &dir, Reason::Daily, 1000);
    let point = open_point(&dir.join(&taken.file));
    assert_eq!(ids(&point, "SELECT id FROM tracks ORDER BY id"), vec![1, 2, 3, 4, 5]);
    assert_eq!(
        rows(&point, "SELECT id, content_hash FROM covers ORDER BY id"),
        rows(&conn, "SELECT id, content_hash FROM covers WHERE id <> 4 ORDER BY id")
    );
    drop(point);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_meta_row_records_the_point() {
    let dir = temp_dir("meta");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    let taken = take(&conn, &dir, Reason::Action, Some("tags_apply"), 1000)
        .unwrap()
        .unwrap();
    let schema: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();

    let listed = list(&dir).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].file, taken.file);
    assert_eq!(listed[0].bytes, taken.bytes);
    assert_eq!(
        listed[0].status,
        PointStatus::Ready(PointMeta {
            format: 1,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_version: schema,
            created_at: 1000,
            reason: "action".to_string(),
            detail: Some("tags_apply".to_string()),
            albums: 1,
            singles: 1,
            playlists: 2,
            filed_tracks: 3,
            edited_tracks: 1,
            genre_tracks: 2,
            content_hash: taken.content_hash.clone(),
        })
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_live_hash_matches_a_point_until_the_library_changes() {
    let dir = temp_dir("hash");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    let taken = take_at(&conn, &dir, Reason::Daily, 1000);
    let changes = conn.total_changes();
    assert_eq!(live_hash(&conn).unwrap(), taken.content_hash);
    assert_eq!(conn.total_changes(), changes, "hashing writes nothing");

    // A change outside the captured tables leaves the hash alone.
    conn.execute("INSERT INTO plays (track_id, played_at, completed) VALUES (1, 5, 1)", [])
        .unwrap();
    assert_eq!(live_hash(&conn).unwrap(), taken.content_hash);

    conn.execute("UPDATE track_genres SET position = 3 WHERE track_id = 1 AND genre_id = 2", [])
        .unwrap();
    assert_ne!(live_hash(&conn).unwrap(), taken.content_hash);
    let _ = std::fs::remove_dir_all(&dir);
}

// A library whose membership and genre rows are inserted in key order, or in reverse.
fn keyed_library(reverse: bool) -> Connection {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO roots (id, root_key, path, added_at) VALUES (1, '/music/main', '/Music/Main', 1);
         INSERT INTO albums (id, title, created_at, updated_at) VALUES (1, 'A', 1, 1), (2, 'B', 1, 1);
         INSERT INTO genres (id, name, name_key, created_at) VALUES (1, 'X', 'x', 1), (2, 'Y', 'y', 1);",
    )
    .unwrap();
    for id in 1..=4 {
        add_track(&conn, id, 1, &walk(MAIN, &[&format!("{id}.flac")]), true);
    }
    let mut members = vec![(1, 1), (1, 2), (2, 3), (2, 4)];
    let mut tagged = vec![(1, 1), (1, 2), (2, 1), (4, 2)];
    if reverse {
        members.reverse();
        tagged.reverse();
    }
    for (album, track) in members {
        conn.execute(
            "INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (?1, ?2, ?2)",
            params![album, track],
        )
        .unwrap();
    }
    for (track, genre) in tagged {
        conn.execute(
            "INSERT INTO track_genres (track_id, genre_id, position) VALUES (?1, ?2, ?2)",
            params![track, genre],
        )
        .unwrap();
    }
    conn
}

#[test]
fn the_content_hash_reads_in_key_order() {
    let dir = temp_dir("key_order");
    let ordered = keyed_library(false);
    let reversed = keyed_library(true);
    assert_eq!(live_hash(&ordered).unwrap(), live_hash(&reversed).unwrap());
    // The point stores those tables in key order whatever order they were written in.
    let taken = take_at(&reversed, &dir, Reason::Daily, 1000);
    assert_eq!(taken.content_hash, live_hash(&reversed).unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_empty_library_writes_nothing() {
    let parent = temp_dir("empty");
    let dir = parent.join(DIR_NAME);
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "INSERT INTO roots (id, root_key, path, added_at) VALUES (1, '/m', '/m', 1);
         INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, scanned_at, root_id)
         VALUES ('/m/a.mp3', 'a.mp3', 'mp3', 1, 1, 1, 1);",
    )
    .unwrap();
    assert!(take(&conn, &dir, Reason::Version, None, 1000).unwrap().is_none());
    assert!(!dir.exists(), "no folder is made for a skipped point");

    // A genre alone is user work a point keeps.
    conn.execute("INSERT INTO genres (name, name_key, created_at) VALUES ('Jazz', 'jazz', 1)", [])
        .unwrap();
    assert!(take(&conn, &dir, Reason::Version, None, 1000).unwrap().is_some());
    let _ = std::fs::remove_dir_all(&parent);
}

// ---- Snapshot ----

#[test]
fn a_staged_point_excludes_a_write_made_after_it() {
    let dir = temp_dir("pinned");
    let points = dir.join(DIR_NAME);
    let db_path = dir.join("plisto.sqlite");
    let mut live = db::open_db(&db_path).unwrap();
    seed(&live);
    let before = whole_state(&live);
    let before_hash = live_hash(&live).unwrap();

    // Staged on a connection of its own, as an action's guard would, then the action commits on the
    // live connection while the point waits.
    let staged = stage(db::open_db(&db_path).unwrap(), &points, Reason::Version, Some("2.7.1"), 1000)
        .unwrap()
        .unwrap();
    let tx = live.transaction().unwrap();
    tx.execute(
        "INSERT INTO albums (title, created_at, updated_at) VALUES ('After', 1, 1)",
        [],
    )
    .unwrap();
    tx.execute("DELETE FROM track_edits", []).unwrap();
    tx.execute("DELETE FROM playlist_tracks WHERE album_id IS NOT NULL", []).unwrap();
    tx.commit().unwrap();
    let reader = db::open_db(&db_path).unwrap();
    assert_ne!(whole_state(&reader), before, "the write is committed and visible");

    let taken = std::thread::spawn(move || finish(staged)).join().unwrap().unwrap();
    let point = open_point(&points.join(&taken.file));
    assert_eq!(whole_state(&point), before);
    assert_eq!(taken.content_hash, before_hash);
    assert_ne!(live_hash(&live).unwrap(), taken.content_hash);
    drop(reader);
    drop(point);
    drop(live);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_staged_point_dropped_unfinished_leaves_nothing() {
    let dir = temp_dir("dropped");
    let points = dir.join(DIR_NAME);
    let db_path = dir.join("plisto.sqlite");
    let live = db::open_db(&db_path).unwrap();
    seed(&live);
    let staged = stage(db::open_db(&db_path).unwrap(), &points, Reason::Daily, None, 1000)
        .unwrap()
        .unwrap();
    assert_eq!(names_in(&points), vec!["rp-1000-daily.tmp"]);
    drop(staged);
    assert!(names_in(&points).is_empty());
    drop(live);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_stray_tmp_is_swept_but_one_being_written_is_kept() {
    let dir = temp_dir("sweep");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    std::fs::create_dir(dir.join("sub")).unwrap();
    // A second spelling of the same folder.
    let other = dir.join("sub").join("..");

    // A `.tmp` another take holds, left closed so no OS lock protects it: only the in-flight set does.
    let (_, held) = claim_names(&point_dir(&dir).unwrap(), Reason::Version, 5000);
    std::fs::write(dir.join("rp-5000-version.tmp"), b"being written").unwrap();
    std::fs::write(dir.join("rp-1-daily.tmp"), b"left by a crash").unwrap();

    take_at(&conn, &other, Reason::Action, 6000);
    assert_eq!(
        names_in(&dir),
        vec!["rp-5000-version.tmp", "rp-6000-action.sqlite", "sub"]
    );

    drop(held);
    take_at(&conn, &other, Reason::Action, 7000);
    assert_eq!(
        names_in(&dir),
        vec!["rp-6000-action.sqlite", "rp-7000-action.sqlite", "sub"]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_staged_point_finishes_after_another_take() {
    let dir = temp_dir("staged_other");
    let points = dir.join(DIR_NAME);
    let db_path = dir.join("plisto.sqlite");
    let live = db::open_db(&db_path).unwrap();
    seed(&live);
    let staged = stage(db::open_db(&db_path).unwrap(), &points, Reason::Version, None, 5000)
        .unwrap()
        .unwrap();
    take_at(&live, &points, Reason::Action, 6000);
    assert_eq!(
        names_in(&points),
        vec!["rp-5000-version.tmp", "rp-6000-action.sqlite"]
    );
    finish(staged).unwrap();
    assert_eq!(
        names_in(&points),
        vec!["rp-5000-version.sqlite", "rp-6000-action.sqlite"]
    );
    drop(live);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_caller_transaction_is_refused_and_left_intact() {
    let dir = temp_dir("caller_tx");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    conn.execute_batch(
        "BEGIN;
         INSERT INTO albums (id, title, created_at, updated_at) VALUES (50, 'Pending', 1, 1);",
    )
    .unwrap();

    let err = take(&conn, &dir, Reason::Action, None, 1000).unwrap_err();
    assert!(err.error.contains("transaction"), "{}", err.error);
    assert!(!conn.is_autocommit(), "the caller's transaction is still open");
    conn.execute_batch("COMMIT").unwrap();
    let title: String = conn
        .query_row("SELECT title FROM albums WHERE id = 50", [], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "Pending", "the caller's write committed");
    assert!(names_in(&dir).is_empty());

    let owned = db::open_in_memory().unwrap();
    seed(&owned);
    owned.execute_batch("BEGIN").unwrap();
    assert!(stage(owned, &dir, Reason::Version, None, 1000).is_err());
    assert!(names_in(&dir).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_clock_set_back_never_prunes_the_new_point() {
    let dir = temp_dir("clock_back");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    for ms in 1000..=1006 {
        std::fs::write(dir.join(format!("rp-{ms}-daily.sqlite")), b"").unwrap();
    }
    std::fs::write(dir.join("rp-9999-action.sqlite"), b"").unwrap();

    let taken = take_at(&conn, &dir, Reason::Daily, 10);
    assert_eq!(taken.file, "rp-1007-daily.sqlite", "named after the ring's newest");
    assert_eq!(taken.pruned, Ok(Pruned { removed: 1, kept: 7 }));
    assert!(dir.join(&taken.file).is_file());
    assert!(!dir.join("rp-1000-daily.sqlite").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn two_points_in_the_same_millisecond_get_their_own_files() {
    let dir = temp_dir("same_ms");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    assert_eq!(take_at(&conn, &dir, Reason::Action, 1000).file, "rp-1000-action.sqlite");
    let second = take_at(&conn, &dir, Reason::Action, 1000);
    assert_eq!(second.file, "rp-1001-action.sqlite");
    assert_eq!(second.created_at, 1001);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- Failure ----

// A library large enough to outgrow a few pages.
fn seed_many(conn: &mut Connection, tracks: i64) {
    let tx = conn.transaction().unwrap();
    tx.execute_batch(
        "INSERT INTO roots (id, root_key, path, added_at) VALUES (1, '/m', '/M', 1);
         INSERT INTO albums (id, title, created_at, updated_at) VALUES (1, 'Big', 1, 1);",
    )
    .unwrap();
    {
        let mut track = tx
            .prepare(
                "INSERT INTO tracks (id, source_path, display_path, filename, ext, size_bytes, mtime,
                                     scanned_at, root_id)
                 VALUES (?1, ?2, ?2, 'x.mp3', 'mp3', 1, 1, 1, 1)",
            )
            .unwrap();
        let mut member = tx
            .prepare("INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (1, ?1, ?1)")
            .unwrap();
        for id in 1..=tracks {
            track
                .execute(params![id, format!("/m/a fairly long folder name/track {id:06}.mp3")])
                .unwrap();
            member.execute(params![id]).unwrap();
        }
    }
    tx.commit().unwrap();
}

#[test]
fn a_full_disk_leaves_no_tmp_and_prunes_nothing() {
    let dir = temp_dir("full");
    let mut conn = db::open_in_memory().unwrap();
    seed_many(&mut conn, 2000);
    for ms in 1..=9 {
        std::fs::write(dir.join(format!("rp-{ms}-daily.sqlite")), b"").unwrap();
    }
    let before = names_in(&dir);

    let job = Job {
        dir: &dir,
        reason: Reason::Daily,
        detail: None,
        now_ms: 1000,
        max_pages: Some(24),
    };
    let err = take_job(&conn, &job).unwrap_err();
    assert!(err.error.contains("full"), "{}", err.error);
    assert_eq!(names_in(&dir), before, "no .tmp and no pruning after a failed write");

    let taken = take_at(&conn, &dir, Reason::Daily, 2000);
    assert_eq!(taken.pruned, Ok(Pruned { removed: 3, kept: 7 }));
    let left = names_in(&dir);
    assert_eq!(left.len(), 7);
    assert!(left.contains(&"rp-2000-daily.sqlite".to_string()));
    assert!(!left.contains(&"rp-3-daily.sqlite".to_string()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_blocked_destination_leaves_no_tmp() {
    let dir = temp_dir("blocked");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);

    // A folder squatting the point's name blocks the rename.
    std::fs::create_dir(dir.join("rp-5000-daily.sqlite")).unwrap();
    assert!(take(&conn, &dir, Reason::Daily, None, 5000).is_err());
    assert_eq!(names_in(&dir), vec!["rp-5000-daily.sqlite"]);
    assert!(dir.join("rp-5000-daily.sqlite").is_dir());

    // A file where the folder should be.
    let file = dir.join("not-a-folder");
    std::fs::write(&file, b"x").unwrap();
    assert!(take(&conn, &file, Reason::Daily, None, 6000).is_err());
    assert_eq!(std::fs::read(&file).unwrap(), b"x");

    // The connection is left usable and detached.
    assert!(take(&conn, &dir.join("ok"), Reason::Daily, None, 7000).unwrap().is_some());
    let attached: Vec<String> = conn
        .prepare("SELECT name FROM pragma_database_list WHERE name NOT IN ('main', 'temp')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(attached.is_empty(), "{attached:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_non_ascii_data_folder_takes_and_lists() {
    let parent = temp_dir("donn\u{e9}es_\u{97f3}\u{697d}");
    let dir = parent.join(DIR_NAME);
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    let taken = take_at(&conn, &dir, Reason::Restore, 1000);
    let listed = list(&dir).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(matches!(listed[0].status, PointStatus::Ready(_)));
    assert_eq!(
        disk_use(&dir).unwrap(),
        DiskUse {
            points: 1,
            bytes: taken.bytes
        }
    );
    let _ = std::fs::remove_dir_all(&parent);
}

// ---- Listing ----

#[test]
fn newer_truncated_and_foreign_files_are_flagged() {
    let dir = temp_dir("flagged");
    let conn = db::open_in_memory().unwrap();
    seed(&conn);
    take_at(&conn, &dir, Reason::Daily, 1000);
    let newer = take_at(&conn, &dir, Reason::Daily, 2000);
    let cut = take_at(&conn, &dir, Reason::Action, 3000);
    std::fs::write(dir.join("rp-4000-version.sqlite"), b"not a database").unwrap();
    std::fs::write(dir.join("rp-5000-daily.tmp"), b"").unwrap();
    std::fs::write(dir.join("notes.txt"), b"").unwrap();

    Connection::open(dir.join(&newer.file))
        .unwrap()
        .execute("UPDATE meta SET format = 2", [])
        .unwrap();
    let cut_path = dir.join(&cut.file);
    let file = std::fs::OpenOptions::new().write(true).open(&cut_path).unwrap();
    file.set_len(cut.bytes / 2).unwrap();
    drop(file);

    let listed = list(&dir).unwrap();
    let files: Vec<&str> = listed.iter().map(|e| e.file.as_str()).collect();
    assert_eq!(
        files,
        vec![
            "rp-4000-version.sqlite",
            "rp-3000-action.sqlite",
            "rp-2000-daily.sqlite",
            "rp-1000-daily.sqlite"
        ]
    );
    assert!(matches!(listed[0].status, PointStatus::Unreadable { .. }));
    assert_eq!(listed[0].reason, Reason::Version);
    assert!(matches!(listed[1].status, PointStatus::Unreadable { .. }));
    assert_eq!(listed[2].status, PointStatus::Newer { format: 2 });
    assert!(matches!(listed[3].status, PointStatus::Ready(_)));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_folder_lists_nothing() {
    let parent = temp_dir("missing");
    let dir = parent.join("absent");
    assert!(list(&dir).unwrap().is_empty());
    assert_eq!(disk_use(&dir).unwrap(), DiskUse { points: 0, bytes: 0 });
    assert_eq!(prune(&dir, Reason::Daily).unwrap(), Pruned { removed: 0, kept: 0 });
    let _ = std::fs::remove_dir_all(&parent);
}

// ---- Retention ----

#[test]
fn each_ring_keeps_its_newest_points() {
    let dir = temp_dir("rings");
    let made = [
        (Reason::Version, 5),
        (Reason::Daily, 10),
        (Reason::Action, 6),
        (Reason::Restore, 3),
    ];
    for (reason, count) in made {
        for ms in 1..=count {
            std::fs::write(dir.join(format!("rp-{ms}-{}.sqlite", reason.as_str())), b"").unwrap();
        }
    }
    std::fs::write(dir.join("rp-99-daily.tmp"), b"").unwrap();
    std::fs::write(dir.join("notes.txt"), b"").unwrap();

    for (reason, count) in made {
        let keep = ring_size(reason);
        assert_eq!(
            prune(&dir, reason).unwrap(),
            Pruned {
                removed: count - keep,
                kept: keep
            }
        );
        let left: BTreeSet<String> = names_in(&dir)
            .into_iter()
            .filter(|n| n.ends_with(&format!("-{}.sqlite", reason.as_str())))
            .collect();
        let expected: BTreeSet<String> = (count - keep + 1..=count)
            .map(|ms| format!("rp-{ms}-{}.sqlite", reason.as_str()))
            .collect();
        assert_eq!(left, expected, "{} keeps its newest", reason.as_str());
    }
    assert!(dir.join("rp-99-daily.tmp").exists());
    assert!(dir.join("notes.txt").exists());
    assert_eq!(
        disk_use(&dir).unwrap().points,
        3 + 7 + 5 + 2,
        "the rings hold their sizes"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn ring_sizes_are_three_seven_five_two() {
    assert_eq!(ring_size(Reason::Version), 3);
    assert_eq!(ring_size(Reason::Daily), 7);
    assert_eq!(ring_size(Reason::Action), 5);
    assert_eq!(ring_size(Reason::Restore), 2);
}

#[test]
fn only_point_names_parse() {
    use super::format::parse_file_name;
    assert_eq!(parse_file_name("rp-1700000000000-daily.sqlite"), Some((1_700_000_000_000, Reason::Daily)));
    assert_eq!(parse_file_name("rp-5-restore.sqlite"), Some((5, Reason::Restore)));
    for name in [
        "rp-5-daily.tmp",
        "rp--daily.sqlite",
        "rp-+5-daily.sqlite",
        "rp-5-weekly.sqlite",
        "rp-5-daily.sqlite.bak",
        "plisto.sqlite",
    ] {
        assert_eq!(parse_file_name(name), None, "{name}");
    }
}

// ---- Coverage guard ----

// Live tables that are neither captured nor excluded.
fn uncovered_tables(conn: &Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap();
    let names: Vec<String> = stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    names
        .into_iter()
        .filter(|n| {
            !DATA_TABLES.iter().any(|t| t.name == n.as_str())
                && !EXCLUDED_TABLES.iter().any(|(t, _)| *t == n.as_str())
        })
        .collect()
}

fn live_columns(conn: &Connection, table: &str) -> BTreeSet<String> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1)").unwrap();
    let names = stmt
        .query_map(params![table], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    names
}

// Columns of captured tables that are neither in the format nor excluded, as `table.column`.
fn uncovered_columns(conn: &Connection) -> Vec<String> {
    let mut out = Vec::new();
    for table in DATA_TABLES {
        for column in live_columns(conn, table.name) {
            let handled = table.columns.contains(&column.as_str())
                || EXCLUDED_COLUMNS
                    .iter()
                    .any(|(t, c, _)| *t == table.name && *c == column);
            if !handled {
                out.push(format!("{}.{column}", table.name));
            }
        }
    }
    out
}

#[test]
fn every_live_table_and_column_is_captured_or_excluded() {
    let conn = db::open_in_memory().unwrap();
    assert_eq!(uncovered_tables(&conn), Vec::<String>::new());
    assert_eq!(uncovered_columns(&conn), Vec::<String>::new());

    // No stale entry: every listed table and column exists, and none is both captured and excluded.
    for (table, _) in EXCLUDED_TABLES {
        assert!(!live_columns(&conn, table).is_empty(), "excluded table {table} exists");
        assert!(!DATA_TABLES.iter().any(|t| t.name == *table));
    }
    for table in DATA_TABLES {
        let live = live_columns(&conn, table.name);
        for column in table.columns {
            assert!(live.contains(*column), "{}.{column} exists", table.name);
        }
    }
    for (table, column, _) in EXCLUDED_COLUMNS {
        assert!(live_columns(&conn, table).contains(*column));
    }

    // The point schema holds exactly the captured columns.
    let dir = temp_dir("guard");
    seed(&conn);
    let taken = take_at(&conn, &dir, Reason::Daily, 1000);
    let point = open_point(&dir.join(&taken.file));
    for table in DATA_TABLES {
        let expected: BTreeSet<String> = table.columns.iter().map(|c| c.to_string()).collect();
        assert_eq!(live_columns(&point, table.name), expected, "point {}", table.name);
    }
    drop(point);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_guard_trips_on_a_new_table_or_column() {
    let conn = db::open_in_memory().unwrap();
    conn.execute_batch(
        "ALTER TABLE albums ADD COLUMN mood TEXT;
         ALTER TABLE track_genres ADD COLUMN weight INTEGER;
         CREATE TABLE album_notes (album_id INTEGER, note TEXT);",
    )
    .unwrap();
    assert_eq!(uncovered_tables(&conn), vec!["album_notes"]);
    assert_eq!(uncovered_columns(&conn), vec!["albums.mood", "track_genres.weight"]);
}

// ---- Scale ----

// A synthetic 50k-track library: 3900 albums of 12, 2000 singles, 1200 loose tracks, 100 playlists of
// 100 slots with every tenth an album entry, 5000 edited tracks, 40 genres on every filed track (two on
// half of them), 2000 track covers and 1000 track visualizers.
fn seed_50k(conn: &mut Connection) {
    let tx = conn.transaction().unwrap();
    let root = "/Music/Library";
    tx.execute(
        "INSERT INTO roots (id, root_key, path, added_at) VALUES (1, ?1, ?2, 1)",
        params![normalize_path_key(root), root],
    )
    .unwrap();
    {
        let mut track = tx
            .prepare(
                "INSERT INTO tracks (id, source_path, display_path, filename, ext, size_bytes, mtime,
                                     duration_secs, has_embedded_cover, scanned_at, root_id)
                 VALUES (?1, ?2, ?3, ?4, 'flac', ?5, 1, 241.5, 1, 1, 1)",
            )
            .unwrap();
        for id in 1..=50_000i64 {
            let file = format!("{:02} - Track Title {id:05}.flac", id % 12 + 1);
            let artist = format!("Artist {:04}", id / 120);
            let album = format!("Album {:05}", id / 12);
            let display = walk(root, &[&artist, &album, &file]);
            track
                .execute(params![id, normalize_path_key(&display), display, file, 30_000_000 + id])
                .unwrap();
        }
        let mut cover = tx
            .prepare(
                "INSERT INTO covers (id, content_hash, source_kind, width, height, byte_len, created_at)
                 VALUES (?1, ?2, 'imported', 600, 600, 90000, 1)",
            )
            .unwrap();
        for id in 1..=4000i64 {
            cover.execute(params![id, format!("{id:064x}")]).unwrap();
        }
        let mut album = tx
            .prepare(
                "INSERT INTO albums (id, title, album_artist, year, genre, cover_id, created_at,
                                     updated_at, kind, visualizer)
                 VALUES (?1, ?2, 'Some Artist', 2004, 'Rock', ?3, 1, 1, ?4, ?5)",
            )
            .unwrap();
        let mut member = tx
            .prepare(
                "INSERT INTO album_tracks (album_id, track_id, track_no, keep_own_cover)
                 VALUES (?1, ?2, ?3, 0)",
            )
            .unwrap();
        for id in 1..=3900i64 {
            let visualizer = (id % 5 == 0).then_some("ridge");
            album
                .execute(params![id, format!("Album {id:05}"), id % 4000 + 1, "album", visualizer])
                .unwrap();
            for n in 1..=12 {
                member.execute(params![id, (id - 1) * 12 + n, n]).unwrap();
            }
        }
        for id in 3901..=5900i64 {
            album
                .execute(params![id, format!("Single {id:05}"), Option::<i64>::None, "single", Option::<&str>::None])
                .unwrap();
            member.execute(params![id, 46_800 + (id - 3900), 1]).unwrap();
        }
        let mut playlist = tx
            .prepare(
                "INSERT INTO playlists (id, name, created_at, updated_at, description)
                 VALUES (?1, ?2, 1, 1, 'A playlist')",
            )
            .unwrap();
        let mut slot = tx
            .prepare(
                "INSERT INTO playlist_tracks (playlist_id, track_id, album_id, keep_order, position)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .unwrap();
        for id in 1..=100i64 {
            playlist.execute(params![id, format!("Playlist {id}")]).unwrap();
            for k in 1..=100i64 {
                if k % 10 == 0 {
                    slot.execute(params![id, Option::<i64>::None, (id * 7 + k) % 3900 + 1, 1, k])
                        .unwrap();
                } else {
                    let track = (id * 997 + k * 31) % 50_000 + 1;
                    slot.execute(params![id, track, Option::<i64>::None, 0, k]).unwrap();
                }
            }
        }
        let mut edit = tx
            .prepare(
                "INSERT INTO track_edits (track_id, title, artist, year, updated_at)
                 VALUES (?1, ?2, 'Edited Artist', 1999, 1)",
            )
            .unwrap();
        for id in (1..=50_000i64).step_by(10) {
            edit.execute(params![id, format!("Edited {id}")]).unwrap();
        }
        let mut genre = tx
            .prepare("INSERT INTO genres (id, name, name_key, created_at) VALUES (?1, ?2, ?3, 1)")
            .unwrap();
        for id in 1..=40i64 {
            genre
                .execute(params![id, format!("Genre {id}"), format!("genre {id}")])
                .unwrap();
        }
        let mut tagged = tx
            .prepare("INSERT INTO track_genres (track_id, genre_id, position) VALUES (?1, ?2, ?3)")
            .unwrap();
        for id in 1..=48_800i64 {
            tagged.execute(params![id, id % 40 + 1, 1]).unwrap();
            if id % 2 == 0 {
                tagged.execute(params![id, (id + 7) % 40 + 1, 2]).unwrap();
            }
        }
        let mut covered = tx
            .prepare("INSERT INTO track_covers (track_id, cover_id, created_at) VALUES (?1, ?2, 1)")
            .unwrap();
        for id in (1..=50_000i64).step_by(25) {
            covered.execute(params![id, id % 4000 + 1]).unwrap();
        }
        let mut shown = tx
            .prepare("INSERT INTO track_visualizers (track_id, kind, updated_at) VALUES (?1, 'glass', 1)")
            .unwrap();
        for id in (1..=50_000i64).step_by(50) {
            shown.execute(params![id]).unwrap();
        }
    }
    tx.commit().unwrap();
}

#[test]
fn a_50k_library_point_is_timed_and_sized() {
    let dir = temp_dir("scale");
    let points = dir.join(DIR_NAME);
    let mut live = db::open_db(&dir.join("plisto.sqlite")).unwrap();
    seed_50k(&mut live);

    let started = Instant::now();
    let hash = live_hash(&live).unwrap();
    let hash_ms = started.elapsed().as_millis();
    let taken = take_at(&live, &points, Reason::Action, 1000);
    assert_eq!(taken.content_hash, hash);

    // The same point split: the stage an action waits for, then the finish on a worker while the
    // action has already committed its write.
    let started = Instant::now();
    let staged = stage(db::open_db(&dir.join("plisto.sqlite")).unwrap(), &points, Reason::Action, None, 2000)
        .unwrap()
        .unwrap();
    let stage_ms = started.elapsed().as_millis();
    live.execute("DELETE FROM album_tracks WHERE album_id <= 100", []).unwrap();
    let started = Instant::now();
    let split = std::thread::spawn(move || finish(staged)).join().unwrap().unwrap();
    let finish_ms = started.elapsed().as_millis();
    assert_eq!(split.content_hash, hash, "the finish reads the pinned snapshot");
    eprintln!(
        "restore point of a 50k-track library: {} bytes; whole take {} ms; stage {stage_ms} ms, \
         finish {finish_ms} ms; live hash {hash_ms} ms",
        taken.bytes, taken.ms
    );

    let listed = list(&points).unwrap();
    let PointStatus::Ready(meta) = &listed[0].status else {
        panic!("the point lists as ready: {:?}", listed[0].status);
    };
    assert_eq!((meta.albums, meta.singles, meta.playlists), (3900, 2000, 100));
    assert_eq!((meta.filed_tracks, meta.edited_tracks, meta.genre_tracks), (48_800, 5000, 48_800));
    let point = open_point(&points.join(&taken.file));
    let full_form: i64 = point
        .query_row("SELECT COUNT(*) FROM tracks WHERE path_key IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(full_form, 0, "every track is stored below its root");
    drop(point);
    drop(live);
    let _ = std::fs::remove_dir_all(&dir);
}
