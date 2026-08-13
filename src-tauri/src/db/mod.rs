/*
 * The SQLite layer: opening a connection with the right pragmas, running migrations, and the
 * one write path into `tracks`. WAL plus a busy timeout is what lets a separate read
 * connection serve queries while a scan writes. Every row that lands here comes from
 * normalize.rs; no SQL builds a TrackRecord field by hand.
 */

// -- Module Declarations --
mod migrations;

// -- Library Imports --
use std::path::Path;

use rusqlite::{params, Connection};

// -- Type Imports --
use crate::model::TrackRecord;

/// Opens (or creates) the database at `path`, applies the pragmas and brings the schema
/// current. This is the connection the app owns in managed state.
pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    apply_pragmas(&conn)?;
    migrations::migrate(&conn)?;
    Ok(conn)
}

/// A throwaway in-memory database with the same pragmas and schema, for tests only.
#[cfg(test)]
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    apply_pragmas(&conn)?;
    migrations::migrate(&conn)?;
    Ok(conn)
}

/// WAL so a reader and the scan writer do not block each other; NORMAL sync as the safe pair
/// for WAL; foreign keys on; a busy timeout so a brief lock retries instead of erroring.
fn apply_pragmas(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )
}

/// Inserts a track, or updates the existing row when `source_path` already exists. Keying on
/// the UNIQUE path means a re-scan updates in place under the same `id` rather than
/// duplicating; every column but the key and `id` is refreshed from the incoming record.
pub fn upsert_track(conn: &Connection, rec: &TrackRecord) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tracks (
            source_path, filename, ext, size_bytes, mtime, duration_secs,
            raw_title, raw_artist, raw_album, raw_album_artist,
            raw_track_no, raw_disc_no, raw_year, raw_genre, scanned_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
         )
         ON CONFLICT(source_path) DO UPDATE SET
            filename = excluded.filename,
            ext = excluded.ext,
            size_bytes = excluded.size_bytes,
            mtime = excluded.mtime,
            duration_secs = excluded.duration_secs,
            raw_title = excluded.raw_title,
            raw_artist = excluded.raw_artist,
            raw_album = excluded.raw_album,
            raw_album_artist = excluded.raw_album_artist,
            raw_track_no = excluded.raw_track_no,
            raw_disc_no = excluded.raw_disc_no,
            raw_year = excluded.raw_year,
            raw_genre = excluded.raw_genre,
            scanned_at = excluded.scanned_at",
        params![
            rec.source_path,
            rec.filename,
            rec.ext,
            rec.size_bytes,
            rec.mtime,
            rec.duration_secs,
            rec.raw_title,
            rec.raw_artist,
            rec.raw_album,
            rec.raw_album_artist,
            rec.raw_track_no,
            rec.raw_disc_no,
            rec.raw_year,
            rec.raw_genre,
            rec.scanned_at,
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TrackRecord;

    fn sample(scanned_at: i64) -> TrackRecord {
        TrackRecord {
            source_path: "/music/song.mp3".to_string(),
            filename: "song.mp3".to_string(),
            ext: "mp3".to_string(),
            size_bytes: 1000,
            mtime: 2000,
            duration_secs: Some(180.5),
            raw_title: Some("Song".to_string()),
            raw_artist: Some("Artist".to_string()),
            raw_album: None,
            raw_album_artist: None,
            raw_track_no: Some(1),
            raw_disc_no: None,
            raw_year: Some(1997),
            raw_genre: None,
            scanned_at,
        }
    }

    fn count_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn fresh_db_is_at_version_one_with_tables() {
        let conn = open_in_memory().unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1);

        for table in ["tracks", "meta"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table} should exist");
        }
    }

    #[test]
    fn migrating_a_current_db_is_a_noop() {
        let conn = open_in_memory().unwrap();
        // A second run must not error and must leave the version untouched.
        migrations::migrate(&conn).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn upsert_is_idempotent_on_same_path() {
        let conn = open_in_memory().unwrap();
        let rec = sample(100);

        upsert_track(&conn, &rec).unwrap();
        upsert_track(&conn, &rec).unwrap();

        assert_eq!(count_rows(&conn), 1);
    }

    #[test]
    fn rescan_updates_in_place_keeping_id() {
        let conn = open_in_memory().unwrap();

        let first = sample(100);
        upsert_track(&conn, &first).unwrap();
        let id_before: i64 = conn
            .query_row("SELECT id FROM tracks", [], |r| r.get(0))
            .unwrap();

        // Same path, changed mtime and a later scan clock: one row, same id, fields advance.
        let mut second = sample(200);
        second.mtime = 3000;
        upsert_track(&conn, &second).unwrap();

        assert_eq!(count_rows(&conn), 1);

        let (id_after, mtime, scanned_at): (i64, i64, i64) = conn
            .query_row("SELECT id, mtime, scanned_at FROM tracks", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(id_after, id_before);
        assert_eq!(mtime, 3000);
        assert_eq!(scanned_at, 200);
    }
}
