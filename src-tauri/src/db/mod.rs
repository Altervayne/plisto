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
use crate::model::{CoverRecord, TrackRecord};

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
            raw_track_no, raw_disc_no, raw_year, raw_genre, has_embedded_cover, scanned_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16
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
            has_embedded_cover = excluded.has_embedded_cover,
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
            rec.has_embedded_cover,
            rec.scanned_at,
        ],
    )?;
    Ok(())
}

/// Inserts a cover into the content-addressed manifest, or returns the existing row's id when
/// its `content_hash` is already present. Identical art from any source collapses to one row,
/// so the caller can upsert freely and rely on the returned id.
pub fn upsert_cover(conn: &Connection, rec: &CoverRecord) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO covers (
            content_hash, source_kind, origin_path, width, height, byte_len, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(content_hash) DO NOTHING",
        params![
            rec.content_hash,
            rec.source_kind,
            rec.origin_path,
            rec.width,
            rec.height,
            rec.byte_len,
            rec.created_at,
        ],
    )?;
    conn.query_row(
        "SELECT id FROM covers WHERE content_hash = ?1",
        params![rec.content_hash],
        |r| r.get(0),
    )
}

/// The cover a user has bound to `folder_path`, or None when they have set none. The resolved
/// thumbnail for a track prefers this over embedded or adjacent art.
pub fn get_folder_cover(conn: &Connection, folder_path: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT cover_id FROM folder_covers WHERE folder_path = ?1",
        params![folder_path],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Binds `cover_id` to `folder_path`, replacing any prior choice. A discrete user action, not
/// part of a scan.
pub fn set_folder_cover(
    conn: &Connection,
    folder_path: &str,
    cover_id: i64,
    set_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO folder_covers (folder_path, cover_id, set_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(folder_path) DO UPDATE SET
            cover_id = excluded.cover_id,
            set_at = excluded.set_at",
        params![folder_path, cover_id, set_at],
    )?;
    Ok(())
}

/// Removes the user's cover choice for `folder_path`, if any. A no-op when none is set. After
/// this, the folder's tracks resolve to embedded or adjacent art again.
pub fn remove_folder_cover(conn: &Connection, folder_path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM folder_covers WHERE folder_path = ?1",
        params![folder_path],
    )?;
    Ok(())
}

/// The source path and tri-state embedded-art flag for one track, or None when no row has that
/// id. The cover commands start from a track id and need its file path to find its folder and
/// its own art.
pub fn get_track_cover_inputs(
    conn: &Connection,
    track_id: i64,
) -> rusqlite::Result<Option<(String, Option<bool>)>> {
    conn.query_row(
        "SELECT source_path, has_embedded_cover FROM tracks WHERE id = ?1",
        params![track_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// The manifest fields a resolved folder cover needs: its content hash (the on-disk thumbnail
/// key), source kind, and pixel dimensions. None when the id is absent.
pub fn get_cover(
    conn: &Connection,
    cover_id: i64,
) -> rusqlite::Result<Option<(String, String, i64, i64)>> {
    conn.query_row(
        "SELECT content_hash, source_kind, width, height FROM covers WHERE id = ?1",
        params![cover_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CoverRecord, TrackRecord};

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
            has_embedded_cover: Some(true),
            scanned_at,
        }
    }

    fn sample_cover(hash: &str) -> CoverRecord {
        CoverRecord {
            content_hash: hash.to_string(),
            source_kind: "embedded".to_string(),
            origin_path: Some("/music/song.mp3".to_string()),
            width: 500,
            height: 500,
            byte_len: 12_345,
            created_at: 100,
        }
    }

    fn count_rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn fresh_db_is_at_version_two_with_tables() {
        let conn = open_in_memory().unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);

        for table in ["tracks", "meta", "covers", "folder_covers"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table} should exist");
        }

        // The tri-state art column lands on tracks.
        let has_col: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tracks') WHERE name = 'has_embedded_cover'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_col, 1, "tracks.has_embedded_cover should exist");
    }

    #[test]
    fn migrating_a_current_db_is_a_noop() {
        let conn = open_in_memory().unwrap();
        // A second run must not error and must leave the version untouched.
        migrations::migrate(&conn).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);
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

    #[test]
    fn upsert_track_maps_the_tri_state_art_flag() {
        let conn = open_in_memory().unwrap();

        let mut rec = sample(100);
        rec.has_embedded_cover = None;
        upsert_track(&conn, &rec).unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT has_embedded_cover FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, None, "None persists as NULL");

        rec.has_embedded_cover = Some(false);
        upsert_track(&conn, &rec).unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT has_embedded_cover FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, Some(0), "Some(false) persists as 0");

        rec.has_embedded_cover = Some(true);
        upsert_track(&conn, &rec).unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT has_embedded_cover FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, Some(1), "Some(true) persists as 1");
    }

    #[test]
    fn upsert_cover_dedups_on_content_hash() {
        let conn = open_in_memory().unwrap();

        let first = upsert_cover(&conn, &sample_cover("abc123")).unwrap();
        let again = upsert_cover(&conn, &sample_cover("abc123")).unwrap();
        assert_eq!(first, again, "identical hash returns the same row id");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM covers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "the duplicate did not insert a second row");

        let other = upsert_cover(&conn, &sample_cover("def456")).unwrap();
        assert_ne!(first, other, "a different hash is a new row");
    }

    #[test]
    fn folder_cover_round_trips_and_replaces() {
        let conn = open_in_memory().unwrap();
        let one = upsert_cover(&conn, &sample_cover("abc123")).unwrap();
        let two = upsert_cover(&conn, &sample_cover("def456")).unwrap();

        assert_eq!(get_folder_cover(&conn, "/music/album").unwrap(), None);

        set_folder_cover(&conn, "/music/album", one, 10).unwrap();
        assert_eq!(get_folder_cover(&conn, "/music/album").unwrap(), Some(one));

        // A second set on the same folder replaces the choice, not appends.
        set_folder_cover(&conn, "/music/album", two, 20).unwrap();
        assert_eq!(get_folder_cover(&conn, "/music/album").unwrap(), Some(two));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM folder_covers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
