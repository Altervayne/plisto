use std::path::PathBuf;
use std::time::Instant;

use rusqlite::types::Value;

use super::*;
use crate::db;
use crate::db::folder_moves::folder_moves;

const MAIN: &str = "/Music/Main";
const OTHER: &str = "/Music/Other";

// The real-case path a walk of `root` yields for the file at `parts` below it.
fn walk(root: &str, parts: &[&str]) -> String {
    parts
        .iter()
        .fold(PathBuf::from(root), |p, c| p.join(c))
        .to_string_lossy()
        .into_owned()
}

fn old() -> String {
    walk(MAIN, &["Old Album"])
}

fn new() -> String {
    walk(MAIN, &["New Album"])
}

fn add_root(conn: &Connection, path: &str) -> i64 {
    db::insert_root(conn, &normalize_path_key(path), path, 1).unwrap()
}

// Inserts a track keyed the way a scan keys `display`; `gone` flags its file missing.
fn add_track(conn: &Connection, root_id: i64, display: &str, size: i64, gone: bool) -> i64 {
    conn.execute(
        "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                             has_embedded_cover, scanned_at, root_id, missing_at)
         VALUES (?1, ?2, 'x.mp3', 'mp3', ?3, 20, 0, 30, ?4, ?5)",
        params![
            normalize_path_key(display),
            display,
            size,
            root_id,
            gone.then_some(40)
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

// The found map for files at `display` paths of the given sizes.
fn found(files: &[(String, i64)]) -> HashMap<String, i64> {
    files
        .iter()
        .map(|(path, size)| (normalize_path_key(path), *size))
        .collect()
}

fn one(conn: &Connection, sql: &str, id: i64) -> i64 {
    conn.query_row(sql, params![id], |r| r.get(0)).unwrap()
}

fn ids(conn: &Connection, sql: &str, id: i64) -> Vec<i64> {
    conn.prepare(sql)
        .unwrap()
        .query_map(params![id], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn paths_of(conn: &Connection, id: i64) -> (String, Option<String>) {
    conn.query_row(
        "SELECT source_path, display_path FROM tracks WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn walked(display: &str) -> (String, Option<String>) {
    (normalize_path_key(display), Some(display.to_string()))
}

fn is_gone(conn: &Connection, id: i64) -> bool {
    one(conn, "SELECT missing_at IS NOT NULL FROM tracks WHERE id = ?1", id) == 1
}

fn exists(conn: &Connection, id: i64) -> bool {
    one(conn, "SELECT COUNT(*) FROM tracks WHERE id = ?1", id) == 1
}

fn dump(conn: &Connection, table: &str, order: &str) -> Vec<Vec<Value>> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
        .unwrap();
    let cols = stmt.column_count();
    stmt.query_map([], |r| (0..cols).map(|i| r.get::<_, Value>(i)).collect())
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

// Every table a folder locate may write, dumped together for before/after comparison.
fn whole_state(conn: &Connection) -> Vec<Vec<Vec<Value>>> {
    vec![
        dump(conn, "roots", "id"),
        dump(conn, "tracks", "id"),
        dump(conn, "folder_covers", "folder_path"),
        dump(conn, "settings", "key"),
        dump(conn, "albums", "id"),
        dump(conn, "album_tracks", "track_id"),
        dump(conn, "playlist_tracks", "id"),
        dump(conn, "plays", "id"),
        dump(conn, "track_edits", "track_id"),
        dump(conn, "track_genres", "track_id, genre_id"),
        dump(conn, "track_covers", "track_id"),
        dump(conn, "duplicate_dismissals", "track_lo, track_hi"),
        dump(conn, "scan_issues", "id"),
    ]
}

fn track_row(conn: &Connection, id: i64) -> Vec<Value> {
    dump(conn, "tracks", "id")
        .into_iter()
        .find(|r| r[0] == Value::Integer(id))
        .unwrap()
}

// Under Old Album: t[0] found with no row at its new path, t[1] found where a scan added `n`, t[2]
// found at another size, t[3] not found; `present` still on disk, `elsewhere` gone in another folder.
struct Fx {
    main: i64,
    other: i64,
    t: [i64; 4],
    n: i64,
    present: i64,
    elsewhere: i64,
}

// `new_folder` is where `n` sits, under OTHER's root when it is below OTHER.
fn fixture(conn: &Connection, new_folder: &str) -> Fx {
    let main = add_root(conn, MAIN);
    let other = add_root(conn, OTHER);
    let n_root = if new_folder.starts_with(OTHER) { other } else { main };
    let t = [
        add_track(conn, main, &walk(&old(), &["1.mp3"]), 11, true),
        add_track(conn, main, &walk(&old(), &["Disc 2", "2.mp3"]), 12, true),
        add_track(conn, main, &walk(&old(), &["3.mp3"]), 13, true),
        add_track(conn, main, &walk(&old(), &["4.mp3"]), 14, true),
    ];
    let present = add_track(conn, main, &walk(&old(), &["5.mp3"]), 15, false);
    let elsewhere = add_track(conn, main, &walk(MAIN, &["Other Album", "x.mp3"]), 16, true);
    let n = add_track(conn, n_root, &walk(new_folder, &["Disc 2", "2.mp3"]), 12, false);
    Fx {
        main,
        other,
        t,
        n,
        present,
        elsewhere,
    }
}

fn found_at(new_folder: &str) -> HashMap<String, i64> {
    found(&[
        (walk(new_folder, &["1.mp3"]), 11),
        (walk(new_folder, &["Disc 2", "2.mp3"]), 12),
        (walk(new_folder, &["3.mp3"]), 99),
        (walk(new_folder, &["5.mp3"]), 15),
    ])
}

fn plan_at(conn: &Connection, fx: &Fx, new_folder: &str) -> LocateFolderPlan {
    plan_locate_folder(conn, fx.main, &old(), new_folder, &found_at(new_folder)).unwrap()
}

// ---- Plan and counts ----

#[test]
fn the_plan_sorts_relinks_collisions_and_size_mismatches_and_skips_present_tracks() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    let present_row = track_row(&conn, fx.present);
    let stays_rows = [track_row(&conn, fx.t[2]), track_row(&conn, fx.t[3])];
    let elsewhere_row = track_row(&conn, fx.elsewhere);

    let targets = locate_targets(&conn, fx.main, &old(), &new()).unwrap();
    assert_eq!(
        targets.iter().map(|t| t.track_id).collect::<Vec<_>>(),
        fx.t.to_vec(),
        "only the gone tracks under the folder are looked for"
    );
    assert_eq!(
        targets[1],
        LocateTarget {
            track_id: fx.t[1],
            path: walk(&new(), &["Disc 2", "2.mp3"]),
            key: normalize_path_key(&walk(&new(), &["Disc 2", "2.mp3"])),
            size_bytes: 12,
        }
    );

    let plan = plan_at(&conn, &fx, &new());
    assert_eq!(plan.target_root_id, fx.main);
    assert_eq!(plan.relinked, vec![fx.t[0]]);
    assert_eq!(plan.merged, vec![(fx.t[1], fx.n)]);
    assert_eq!(plan.stays, vec![fx.t[2], fx.t[3]]);
    assert_eq!(plan.albums_replaced, 0);

    let report = locate_folder(&mut conn, &plan, 50).unwrap();

    assert_eq!(
        report,
        LocateFolderReport {
            relinked: 1,
            merged: 1,
            stays: 2,
            albums_replaced: 0
        }
    );
    assert_eq!(paths_of(&conn, fx.t[0]), walked(&walk(&new(), &["1.mp3"])));
    assert_eq!(
        paths_of(&conn, fx.t[1]),
        walked(&walk(&new(), &["Disc 2", "2.mp3"]))
    );
    assert!(!exists(&conn, fx.n), "the row at the new path folds away");
    assert!(!is_gone(&conn, fx.t[0]) && !is_gone(&conn, fx.t[1]));
    assert_eq!(
        [track_row(&conn, fx.t[2]), track_row(&conn, fx.t[3])],
        stays_rows
    );
    assert_eq!(track_row(&conn, fx.present), present_row);
    assert_eq!(track_row(&conn, fx.elsewhere), elsewhere_row);
}

#[test]
fn the_apply_plans_again_against_the_library_as_it_is() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    let plan = plan_at(&conn, &fx, &new());
    // A scan adds the relinked track's file as a new row after the plan.
    let since = add_track(&conn, fx.main, &walk(&new(), &["1.mp3"]), 11, false);

    let report = locate_folder(&mut conn, &plan, 50).unwrap();

    assert_eq!((report.relinked, report.merged), (0, 2));
    assert!(!exists(&conn, since));
    assert_eq!(paths_of(&conn, fx.t[0]), walked(&walk(&new(), &["1.mp3"])));
}

#[test]
fn the_move_is_recorded_below_the_roots() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    let plan = plan_at(&conn, &fx, &new());

    locate_folder(&mut conn, &plan, 50).unwrap();

    assert_eq!(
        folder_moves(&conn).unwrap(),
        vec![FolderMove {
            from_root_id: fx.main,
            from_rel: normalize_path_key("Old Album"),
            to_root_id: fx.main,
            to_rel: normalize_path_key("New Album"),
            at: 50,
        }]
    );
}

// ---- The fold ----

#[test]
fn a_fold_keeps_the_gone_track_id_edits_membership_slots_and_plays() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    let t = fx.t[1];
    let record = db::create_album(
        &mut conn,
        Some("Record".into()),
        None,
        None,
        None,
        None,
        &[fx.t[0], t],
        db::ALBUM_KIND,
        5,
    )
    .unwrap()
    .id;
    // The scan's row was filed alone into an album made since.
    let since = db::create_album(
        &mut conn,
        Some("Since".into()),
        None,
        None,
        None,
        None,
        &[fx.n],
        db::ALBUM_KIND,
        5,
    )
    .unwrap()
    .id;
    conn.execute_batch(
        "INSERT INTO albums (id, title, kind, created_at, updated_at) VALUES (90, 'Emptied by hand', 'album', 1, 1);
         INSERT INTO playlists (id, created_at, updated_at) VALUES (1, 1, 1);",
    )
    .unwrap();
    for (pos, track) in [(1, Some(t)), (2, Some(fx.n)), (3, None)] {
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, album_id, keep_order, position)
             VALUES (1, ?1, ?2, ?3, ?4)",
            params![track, track.is_none().then_some(since), track.is_none() as i64, pos],
        )
        .unwrap();
    }
    for (track, plays) in [(t, 2), (fx.n, 3)] {
        for i in 0..plays {
            conn.execute(
                "INSERT INTO plays (track_id, played_at, completed) VALUES (?1, ?2, 1)",
                params![track, 100 + i],
            )
            .unwrap();
        }
    }
    conn.execute(
        "INSERT INTO track_edits (track_id, title, updated_at) VALUES (?1, 'Kept', 1)",
        params![t],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO track_edits (track_id, title, artist, updated_at) VALUES (?1, 'New', 'Filled', 2)",
        params![fx.n],
    )
    .unwrap();

    let plan = plan_at(&conn, &fx, &new());
    assert_eq!(plan.albums_replaced, 1);
    let report = locate_folder(&mut conn, &plan, 50).unwrap();

    assert_eq!(report.albums_replaced, 1);
    assert_eq!(db::membership_album(&conn, t).unwrap(), Some(record));
    assert!(db::get_album(&conn, since).unwrap().is_none());
    assert!(
        db::get_album(&conn, 90).unwrap().is_some(),
        "an album the fold did not empty is left alone"
    );
    assert_eq!(
        one(&conn, "SELECT COUNT(*) FROM plays WHERE track_id = ?1", t),
        5
    );
    assert_eq!(
        ids(
            &conn,
            "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position, id",
            1
        ),
        vec![t, t, t],
        "both slots and the emptied album's entry land on the gone track"
    );
    let edit: (String, String) = conn
        .query_row(
            "SELECT title, artist FROM track_edits WHERE track_id = ?1",
            params![t],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(edit, ("Kept".to_string(), "Filled".to_string()));
}

#[test]
fn a_found_track_reads_present_even_when_the_row_at_its_new_path_was_flagged_gone() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    conn.execute(
        "UPDATE tracks SET missing_at = 45 WHERE id = ?1",
        params![fx.n],
    )
    .unwrap();
    let plan = plan_at(&conn, &fx, &new());

    locate_folder(&mut conn, &plan, 50).unwrap();

    assert!(!is_gone(&conn, fx.t[0]));
    assert!(!is_gone(&conn, fx.t[1]), "the stat proved the file is there");
}

#[test]
fn a_target_in_another_root_moves_the_found_tracks_and_their_issues_to_it() {
    let mut conn = db::open_in_memory().unwrap();
    let found_folder = walk(OTHER, &["Found"]);
    let fx = fixture(&conn, &found_folder);
    let issue_key = paths_of(&conn, fx.t[0]).0;
    conn.execute(
        "INSERT INTO scan_issues (path_key, path, root_id, track_id, kind, reason, detail, first_seen,
                                  last_seen)
         VALUES (?1, ?1, ?2, ?3, 'tags', 'other', 'boom', 1, 1)",
        params![issue_key, fx.main, fx.t[0]],
    )
    .unwrap();

    let plan = plan_at(&conn, &fx, &found_folder);
    assert_eq!(plan.target_root_id, fx.other);
    locate_folder(&mut conn, &plan, 50).unwrap();

    for t in [fx.t[0], fx.t[1]] {
        assert_eq!(
            one(&conn, "SELECT root_id FROM tracks WHERE id = ?1", t),
            fx.other
        );
    }
    assert_eq!(
        one(&conn, "SELECT root_id FROM tracks WHERE id = ?1", fx.t[2]),
        fx.main,
        "a track that stays gone stays where it was"
    );
    assert_eq!(
        paths_of(&conn, fx.t[0]),
        walked(&walk(&found_folder, &["1.mp3"]))
    );
    let issue: (String, i64) = conn
        .query_row(
            "SELECT path_key, root_id FROM scan_issues WHERE track_id = ?1",
            params![fx.t[0]],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        issue,
        (normalize_path_key(&walk(&found_folder, &["1.mp3"])), fx.other)
    );
    assert_eq!(
        folder_moves(&conn).unwrap()[0],
        FolderMove {
            from_root_id: fx.main,
            from_rel: normalize_path_key("Old Album"),
            to_root_id: fx.other,
            to_rel: normalize_path_key("Found"),
            at: 50,
        }
    );
}

// ---- Folder covers ----

fn add_cover(conn: &Connection, hash: &str) -> i64 {
    conn.execute(
        "INSERT INTO covers (content_hash, source_kind, width, height, byte_len, created_at)
         VALUES (?1, 'imported', 1, 1, 1, 1)",
        params![hash],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn folder_key(path: &str) -> String {
    normalize_path_key(path)
}

#[test]
fn a_folder_cover_follows_only_found_tracks_out_of_a_folder_with_no_present_track_left() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    // Disc 3 holds only a track that stays gone; Disc 4 holds one that is found.
    add_track(&conn, fx.main, &walk(&old(), &["Disc 3", "6.mp3"]), 16, true);
    add_track(&conn, fx.main, &walk(&old(), &["Disc 4", "7.mp3"]), 17, true);
    let mut files = found_at(&new());
    files.extend(found(&[(walk(&new(), &["Disc 4", "7.mp3"]), 17)]));
    let covers: Vec<i64> = ["a", "b", "c", "d", "e", "f"]
        .iter()
        .map(|h| add_cover(&conn, h))
        .collect();
    let set = |path: &str, cover: i64| {
        db::set_folder_cover(&conn, &folder_key(path), cover, 1).unwrap();
    };
    // Old Album still holds a present track. Disc 2 and Disc 3 have a cover at their new place too;
    // Disc 4 does not.
    set(&old(), covers[0]);
    set(&walk(&old(), &["Disc 2"]), covers[1]);
    set(&walk(&new(), &["Disc 2"]), covers[2]);
    set(&walk(&old(), &["Disc 3"]), covers[3]);
    set(&walk(&new(), &["Disc 3"]), covers[4]);
    set(&walk(&old(), &["Disc 4"]), covers[5]);
    let plan = plan_locate_folder(&conn, fx.main, &old(), &new(), &files).unwrap();

    locate_folder(&mut conn, &plan, 50).unwrap();

    let cover = |path: &str| db::get_folder_cover(&conn, &folder_key(path)).unwrap();
    assert_eq!(cover(&old()), Some(covers[0]), "a present track still uses it");
    assert_eq!(cover(&new()), None);
    assert_eq!(cover(&walk(&old(), &["Disc 2"])), Some(covers[1]));
    assert_eq!(
        cover(&walk(&new(), &["Disc 2"])),
        Some(covers[2]),
        "a cover already at the new place is kept"
    );
    assert_eq!(
        cover(&walk(&old(), &["Disc 3"])),
        Some(covers[3]),
        "nothing found there, so the gone track keeps its cover"
    );
    assert_eq!(cover(&walk(&new(), &["Disc 3"])), Some(covers[4]));
    assert_eq!(cover(&walk(&old(), &["Disc 4"])), None);
    assert_eq!(cover(&walk(&new(), &["Disc 4"])), Some(covers[5]));
}

// ---- Refusals and failures ----

#[test]
fn refusals_name_their_reason_and_write_nothing() {
    let conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    let before = whole_state(&conn);
    let refused = |root_id: i64, folder: &str, new_path: &str, found: &HashMap<String, i64>| {
        plan_locate_folder(&conn, root_id, folder, new_path, found).unwrap_err()
    };
    let all = found_at(&new());

    let cases = [
        (refused(fx.main, "/Elsewhere/Old Album", &new(), &all), Some("nothing_gone")),
        (refused(fx.main, &walk(MAIN, &["Fresh"]), &new(), &all), Some("nothing_gone")),
        (refused(fx.main, &old(), &old(), &all), Some("same")),
        (refused(fx.main, &old(), &walk(&old(), &["Inside"]), &all), Some("overlap")),
        (refused(fx.main, &old(), MAIN, &all), Some("overlap")),
        (refused(fx.main, &old(), "/Volumes/Stick/Old Album", &all), Some("outside_roots")),
        (refused(fx.main, &old(), &new(), &HashMap::new()), Some("no_match")),
        (refused(999, &old(), &new(), &all), None),
    ];
    for (err, code) in &cases {
        assert_eq!(err.refusal(), *code, "{err}");
    }
    assert!(matches!(cases[7].0, LocateFolderError::RootGone));
    assert!(matches!(
        locate_targets(&conn, fx.main, &old(), "/Volumes/Stick"),
        Err(LocateFolderError::OutsideRoots)
    ));
    assert_eq!(whole_state(&conn), before);
}

#[test]
fn an_out_of_prefix_row_aborts_with_every_table_unchanged() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    let plan = plan_at(&conn, &fx, &new());
    // Keyed under the folder, shown somewhere else.
    conn.execute(
        "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                             has_embedded_cover, scanned_at, root_id, missing_at)
         VALUES (?1, '/Elsewhere/stray.mp3', 'stray.mp3', 'mp3', 1, 20, 0, 30, ?2, 40)",
        params![normalize_path_key(&walk(&old(), &["stray.mp3"])), fx.main],
    )
    .unwrap();
    let stray = conn.last_insert_rowid();
    let before = whole_state(&conn);

    assert!(matches!(
        locate_folder(&mut conn, &plan, 50),
        Err(LocateFolderError::OutOfPrefix { track_id }) if track_id == stray
    ));
    assert_eq!(whole_state(&conn), before);
    assert!(matches!(
        plan_locate_folder(&conn, fx.main, &old(), &new(), &found_at(&new())),
        Err(LocateFolderError::OutOfPrefix { track_id }) if track_id == stray
    ));
}

#[test]
fn a_write_failing_at_the_last_step_leaves_every_table_unchanged() {
    let mut conn = db::open_in_memory().unwrap();
    let fx = fixture(&conn, &new());
    let cover = add_cover(&conn, "a");
    db::set_folder_cover(&conn, &folder_key(&walk(&old(), &["Disc 2"])), cover, 1).unwrap();
    let plan = plan_at(&conn, &fx, &new());
    // Recording the move is the last write; this makes it fail after every other one ran.
    conn.execute_batch(
        "CREATE TEMP TRIGGER refuse_record BEFORE INSERT ON main.settings
         BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    )
    .unwrap();
    let before = whole_state(&conn);

    let err = locate_folder(&mut conn, &plan, 50).unwrap_err();

    assert!(matches!(err, LocateFolderError::Sql(_)), "{err}");
    assert_eq!(err.refusal(), None);
    assert_eq!(whole_state(&conn), before);
    assert!(conn.is_autocommit(), "the transaction is rolled back");
}

// ---- Scale ----

#[test]
fn a_locate_of_5k_gone_tracks_is_timed() {
    let mut conn = db::open_in_memory().unwrap();
    let main = add_root(&conn, MAIN);
    let mut files = Vec::new();
    {
        let tx = conn.transaction().unwrap();
        for i in 0..5000i64 {
            let parts = [format!("Disc {}", i % 10), format!("{i}.mp3")];
            let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
            let t = add_track(&tx, main, &walk(&old(), &parts), 1000 + i, true);
            tx.execute(
                "INSERT INTO plays (track_id, played_at, completed) VALUES (?1, 1, 1)",
                params![t],
            )
            .unwrap();
            // Every other file was already added again by a scan, filed into an album of its own.
            if i % 2 == 0 {
                let n = add_track(&tx, main, &walk(&new(), &parts), 1000 + i, false);
                tx.execute(
                    "INSERT INTO albums (title, kind, created_at, updated_at) VALUES ('Since', 'album', 1, 1)",
                    [],
                )
                .unwrap();
                tx.execute(
                    "INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (?1, ?2, 1)",
                    params![tx.last_insert_rowid(), n],
                )
                .unwrap();
            }
            files.push((walk(&new(), &parts), 1000 + i));
        }
        tx.commit().unwrap();
    }
    let found = found(&files);

    let started = Instant::now();
    let plan = plan_locate_folder(&conn, main, &old(), &new(), &found).unwrap();
    let plan_ms = started.elapsed().as_millis();
    let started = Instant::now();
    let report = locate_folder(&mut conn, &plan, 50).unwrap();
    let apply_ms = started.elapsed().as_millis();
    eprintln!("folder locate of 5000 gone tracks, 2500 folds: plan {plan_ms} ms, apply {apply_ms} ms");

    assert_eq!(
        report,
        LocateFolderReport {
            relinked: 2500,
            merged: 2500,
            stays: 0,
            albums_replaced: 0
        },
        "a loose gone track takes its twin's place in the album"
    );
    assert_eq!(
        one(&conn, "SELECT COUNT(*) FROM tracks WHERE missing_at IS NOT NULL OR root_id <> ?1", main),
        0
    );
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(count("SELECT COUNT(*) FROM tracks"), 5000);
    assert_eq!(count("SELECT COUNT(*) FROM album_tracks"), 2500);
    assert_eq!(count("SELECT COUNT(*) FROM plays"), 5000);
}
