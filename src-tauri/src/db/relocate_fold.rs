/*
 * The pair fold behind a relocate: folds an absorbed track onto its kept twin so the kept id survives.
 * The kept track's user data wins and the absorbed one fills the gaps, plays and playlist slots union
 * onto it, and the absorbed track's scan columns are handed back to the caller to write once the
 * absorbed rows are gone and the kept paths are final.
 */

// -- Library Imports --
use std::collections::HashMap;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};

// -- Local Imports --
use super::duplicates::{
    insert_membership, insert_pairs, list_duplicate_dismissals, membership_row, repoint, PLAYS,
    SLOTS,
};
use super::tag_albums::set_updated_at;
use super::{membership_album, remove_membership};
use crate::dto::{DismissedPair, MergeMembership};

// The columns a scan writes. A kept track paired with an absorbed one takes these from it, since the
// absorbed row is the fresh read of the same file.
const SCAN_COLUMNS: &[&str] = &[
    "source_path",
    "display_path",
    "filename",
    "ext",
    "size_bytes",
    "mtime",
    "duration_secs",
    "raw_title",
    "raw_artist",
    "raw_album",
    "raw_album_artist",
    "raw_track_no",
    "raw_disc_no",
    "raw_year",
    "raw_genre",
    "raw_genres",
    "has_embedded_cover",
    "scanned_at",
    "missing_at",
    "rg_track_gain",
    "rg_track_peak",
    "rg_album_gain",
    "rg_album_peak",
    "gain_tags_read",
    "art_hash",
    "art_width",
    "art_height",
];

// The measured loudness columns. They move as one group, since the stamp is what makes the value valid.
const LOUDNESS_COLUMNS: &[&str] = &[
    "loudness_lufs",
    "loudness_peak",
    "loudness_size",
    "loudness_mtime",
];

const EDIT_COLUMNS: &[&str] = &[
    "title",
    "artist",
    "album",
    "album_artist",
    "year",
    "disc_no",
];

/// Folds each (kept, absorbed) pair: dismissals first, then per pair the user data, loudness and
/// tag-failure record carry onto the kept track and the absorbed row is deleted. Returns each kept
/// id with the absorbed track's scan columns, for `set_scan_values` once the kept paths are final.
pub(super) fn fold_pairs(
    conn: &Connection,
    pairs: &[(i64, i64)],
    now: i64,
) -> rusqlite::Result<Vec<(i64, Vec<Value>)>> {
    carry_dismissals(conn, pairs, now)?;
    let mut scans = Vec::with_capacity(pairs.len());
    for &(o, n) in pairs {
        carry_track(conn, o, n, now)?;
        carry_loudness(conn, o, n)?;
        carry_issue(conn, o, n)?;
        scans.push((o, scan_values(conn, n)?));
        conn.execute("DELETE FROM tracks WHERE id = ?1", params![n])?;
    }
    Ok(scans)
}

/// Hands absorbed track `n`'s tag-failure record to its kept twin `o`. `o` takes `n`'s scan columns, so
/// its own record describes a read that no longer stands and goes.
fn carry_issue(conn: &Connection, o: i64, n: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM scan_issues WHERE track_id = ?1", params![o])?;
    conn.execute(
        "UPDATE scan_issues SET track_id = ?1 WHERE track_id = ?2",
        params![o, n],
    )?;
    Ok(())
}

/// Moves every dismissal that names an absorbed track onto its kept twin. The pair of twins itself
/// drops out, and the old rows cascade away with the absorbed tracks.
fn carry_dismissals(conn: &Connection, pairs: &[(i64, i64)], now: i64) -> rusqlite::Result<()> {
    let twin: HashMap<i64, i64> = pairs.iter().map(|&(o, n)| (n, o)).collect();
    let mut carried = Vec::new();
    for pair in list_duplicate_dismissals(conn)? {
        if !twin.contains_key(&pair.track_lo) && !twin.contains_key(&pair.track_hi) {
            continue;
        }
        let a = twin.get(&pair.track_lo).copied().unwrap_or(pair.track_lo);
        let b = twin.get(&pair.track_hi).copied().unwrap_or(pair.track_hi);
        if a != b {
            carried.push(DismissedPair {
                track_lo: a.min(b),
                track_hi: a.max(b),
            });
        }
    }
    insert_pairs(conn, &carried, now)?;
    Ok(())
}

/// Folds absorbed track `n` onto kept track `o`. Slots and plays union onto o; edits fill o's empty
/// fields; genres, an assigned cover and a visualizer default move only into an o that has none. A
/// filed o keeps its album and n leaves its own; a loose o takes n's place.
fn carry_track(conn: &Connection, o: i64, n: i64, now: i64) -> rusqlite::Result<()> {
    repoint(conn, SLOTS, n, o)?;
    repoint(conn, PLAYS, n, o)?;
    carry_edits(conn, o, n)?;
    for table in ["track_genres", "track_covers", "track_visualizers"] {
        if !has_row(conn, table, o)? {
            conn.execute(
                &format!("UPDATE {table} SET track_id = ?1 WHERE track_id = ?2"),
                params![o, n],
            )?;
        }
    }
    if let Some(m) = membership_row(conn, n)? {
        let o_loose = membership_album(conn, o)?.is_none();
        remove_membership(conn, n)?;
        if o_loose {
            insert_membership(conn, &MergeMembership { track_id: o, ..m })?;
        }
        set_updated_at(conn, m.album_id, now)?;
    }
    Ok(())
}

/// Gives o the measured loudness group of n when n has been measured or tried (its stamp is non-NULL).
/// o keeps its own group otherwise.
fn carry_loudness(conn: &Connection, o: i64, n: i64) -> rusqlite::Result<()> {
    let sets = LOUDNESS_COLUMNS
        .iter()
        .map(|c| format!("{c} = (SELECT {c} FROM tracks WHERE id = ?2)"))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!(
            "UPDATE tracks SET {sets} WHERE id = ?1
               AND (SELECT loudness_size FROM tracks WHERE id = ?2) IS NOT NULL"
        ),
        params![o, n],
    )?;
    Ok(())
}

fn carry_edits(conn: &Connection, o: i64, n: i64) -> rusqlite::Result<()> {
    if !has_row(conn, "track_edits", n)? {
        return Ok(());
    }
    if !has_row(conn, "track_edits", o)? {
        conn.execute(
            "UPDATE track_edits SET track_id = ?1 WHERE track_id = ?2",
            params![o, n],
        )?;
        return Ok(());
    }
    let fills = EDIT_COLUMNS
        .iter()
        .map(|c| format!("{c} = COALESCE({c}, (SELECT {c} FROM track_edits WHERE track_id = ?2))"))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!("UPDATE track_edits SET {fills} WHERE track_id = ?1"),
        params![o, n],
    )?;
    Ok(())
}

fn has_row(conn: &Connection, table: &str, track_id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE track_id = ?1)"),
        params![track_id],
        |r| r.get(0),
    )
}

pub(super) fn scan_values(conn: &Connection, track_id: i64) -> rusqlite::Result<Vec<Value>> {
    conn.query_row(
        &format!(
            "SELECT {} FROM tracks WHERE id = ?1",
            SCAN_COLUMNS.join(", ")
        ),
        params![track_id],
        |r| {
            (0..SCAN_COLUMNS.len())
                .map(|i| r.get::<_, Value>(i))
                .collect()
        },
    )
}

pub(super) fn set_scan_values(
    conn: &Connection,
    track_id: i64,
    values: &[Value],
) -> rusqlite::Result<()> {
    let sets = SCAN_COLUMNS
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{c} = ?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE tracks SET {sets} WHERE id = ?{}",
        SCAN_COLUMNS.len() + 1
    );
    let args = values.iter().cloned().chain([Value::Integer(track_id)]);
    conn.execute(&sql, params_from_iter(args))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn add_track(conn: &Connection, root_id: i64, name: &str, size: i64) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 has_embedded_cover, scanned_at, root_id)
             VALUES (?1, ?1, ?1, 'mp3', ?2, 20, 0, 30, ?3)",
            params![format!("/music/{name}"), size, root_id],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn count(conn: &Connection, sql: &str, id: i64) -> i64 {
        conn.query_row(sql, params![id], |r| r.get(0)).unwrap()
    }

    #[test]
    fn fold_pairs_keeps_the_kept_id_and_unions_the_absorbed_data() {
        let mut conn = db::open_in_memory().unwrap();
        let root = db::insert_root(&conn, "/music", "/Music", 1).unwrap();
        let o = add_track(&conn, root, "a.mp3", 11);
        let n = add_track(&conn, root, "b.mp3", 22);
        let album = db::create_album(
            &mut conn,
            Some("Album".into()),
            None,
            None,
            None,
            None,
            &[n],
            db::ALBUM_KIND,
            5,
        )
        .unwrap()
        .id;
        conn.execute(
            "INSERT INTO track_edits (track_id, title, updated_at) VALUES (?1, 'Kept title', 1)",
            params![o],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO track_edits (track_id, title, artist, updated_at)
             VALUES (?1, 'Other title', 'Filled artist', 2)",
            params![n],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlists (created_at, updated_at) VALUES (1, 1)",
            [],
        )
        .unwrap();
        let playlist = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, 1)",
            params![playlist, n],
        )
        .unwrap();
        for (track, at) in [(o, 100), (n, 101), (n, 102)] {
            conn.execute(
                "INSERT INTO plays (track_id, played_at, completed) VALUES (?1, ?2, 1)",
                params![track, at],
            )
            .unwrap();
        }
        let absorbed_scan = scan_values(&conn, n).unwrap();

        let tx = conn.transaction().unwrap();
        let scans = fold_pairs(&tx, &[(o, n)], 50).unwrap();
        tx.commit().unwrap();

        assert_eq!(scans, vec![(o, absorbed_scan)]);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tracks WHERE id = ?1", n), 0);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM tracks WHERE id = ?1", o), 1);
        assert_eq!(db::membership_album(&conn, o).unwrap(), Some(album));
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM plays WHERE track_id = ?1", o),
            3
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM playlist_tracks WHERE track_id = ?1",
                o
            ),
            1
        );
        let (title, artist): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT title, artist FROM track_edits WHERE track_id = ?1",
                params![o],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (title.as_deref(), artist.as_deref()),
            (Some("Kept title"), Some("Filled artist"))
        );
    }
}
