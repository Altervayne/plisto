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
use crate::dto::{AlbumRow, AlbumTrackRow};
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
            source_path, display_path, filename, ext, size_bytes, mtime, duration_secs,
            raw_title, raw_artist, raw_album, raw_album_artist,
            raw_track_no, raw_disc_no, raw_year, raw_genre, has_embedded_cover, scanned_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
         )
         ON CONFLICT(source_path) DO UPDATE SET
            display_path = excluded.display_path,
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
            rec.display_path,
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

// ---- Settings and workspace ----

/// The value stored under `key`, or None when the key is absent. A client pref falls back to its
/// own default when this is None.
pub fn get_setting(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Stores `value` under `key`, replacing any prior value. The kv store behind every client pref,
/// so a new pref is a new key rather than a schema change.
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// The active workspace root the picker stored, or None before any scan has set one. The folder
/// tree anchors on this.
pub fn get_workspace_root(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT workspace_root FROM meta WHERE id = 1", [], |r| {
        r.get(0)
    })
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

// ---- Albums and membership ----

// The album projection with its live track count. LEFT JOIN so an empty album still returns a row
// with a zero count. Callers append the GROUP BY and, for a single album, a WHERE.
const ALBUM_SELECT: &str = "
    SELECT a.id, a.title, a.album_artist, a.year, a.genre, a.cover_id,
           COUNT(at.track_id) AS track_count, a.created_at, a.updated_at
    FROM albums a
    LEFT JOIN album_tracks at ON at.album_id = a.id";

// The drawer's membership projection: the immutable source fields joined from `tracks` beside the
// per-track override and numbering held on `album_tracks`. Callers append the ORDER BY.
const ALBUM_TRACK_SELECT: &str = "
    SELECT at.album_id, at.track_id, t.source_path, t.filename, t.duration_secs,
           at.track_no, at.disc_no, t.raw_title, t.raw_artist,
           at.title_override, at.artist_override, t.has_embedded_cover, t.missing_at
    FROM album_tracks at
    JOIN tracks t ON t.id = at.track_id";

/// Maps one result row into an AlbumRow. The column order matches ALBUM_SELECT.
fn album_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumRow> {
    Ok(AlbumRow {
        id: r.get(0)?,
        title: r.get(1)?,
        album_artist: r.get(2)?,
        year: r.get(3)?,
        genre: r.get(4)?,
        cover_id: r.get(5)?,
        track_count: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// Maps one result row into an AlbumTrackRow. The column order matches ALBUM_TRACK_SELECT.
fn album_track_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumTrackRow> {
    Ok(AlbumTrackRow {
        album_id: r.get(0)?,
        track_id: r.get(1)?,
        source_path: r.get(2)?,
        filename: r.get(3)?,
        duration_secs: r.get(4)?,
        track_no: r.get(5)?,
        disc_no: r.get(6)?,
        raw_title: r.get(7)?,
        raw_artist: r.get(8)?,
        title_override: r.get(9)?,
        artist_override: r.get(10)?,
        has_embedded_cover: r.get(11)?,
        missing_at: r.get(12)?,
    })
}

/// The source path of one track, or None when no row has that id. The create-time cover pre-fill
/// derives a selection's shared folder from these.
pub fn get_track_source_path(conn: &Connection, track_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT source_path FROM tracks WHERE id = ?1",
        params![track_id],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// One album with its track count, or None when the id is absent.
pub fn get_album(conn: &Connection, album_id: i64) -> rusqlite::Result<Option<AlbumRow>> {
    let sql = format!("{ALBUM_SELECT} WHERE a.id = ?1 GROUP BY a.id");
    conn.query_row(&sql, params![album_id], album_row_from_sql)
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

/// The cover bound to an album, or None when it has none set or the id is absent. The album cover
/// resolves from this first, before falling back to a member track's own art.
pub fn get_album_cover_id(conn: &Connection, album_id: i64) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT cover_id FROM albums WHERE id = ?1",
        params![album_id],
        |r| r.get(0),
    )
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// The lowest-numbered member track of an album, or None when it has no members. The album cover
/// falls back to this track's own art when no cover is bound.
pub fn get_album_first_track(conn: &Connection, album_id: i64) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT track_id FROM album_tracks WHERE album_id = ?1 ORDER BY track_no LIMIT 1",
        params![album_id],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Every album with its track count, ordered by id. One half of the organize snapshot.
pub fn load_albums(conn: &Connection) -> rusqlite::Result<Vec<AlbumRow>> {
    let sql = format!("{ALBUM_SELECT} GROUP BY a.id ORDER BY a.id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], album_row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every membership row across all albums, ordered by album then track number. The other half of
/// the organize snapshot.
pub fn load_album_tracks(conn: &Connection) -> rusqlite::Result<Vec<AlbumTrackRow>> {
    let sql = format!("{ALBUM_TRACK_SELECT} ORDER BY at.album_id, at.track_no");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], album_track_row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Inserts an album and appends `track_ids` as membership rows in order (track_no 1..N, disc_no 1)
/// in one transaction, then returns the new row. `cover_id` is the caller's create-time pre-fill
/// (a shared folder cover) or None. `created_at` and `updated_at` both take `now`.
pub fn create_album(
    conn: &mut Connection,
    title: Option<String>,
    album_artist: Option<String>,
    year: Option<i64>,
    genre: Option<String>,
    cover_id: Option<i64>,
    track_ids: &[i64],
    now: i64,
) -> rusqlite::Result<AlbumRow> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO albums (title, album_artist, year, genre, cover_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![title, album_artist, year, genre, cover_id, now],
    )?;
    let album_id = tx.last_insert_rowid();
    for (i, &track_id) in track_ids.iter().enumerate() {
        insert_album_track(&tx, album_id, track_id, (i as i64) + 1, 1)?;
    }
    tx.commit()?;

    get_album(conn, album_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

/// Deletes an album. The membership foreign keys CASCADE, so the assignment rows go with it while
/// the track rows themselves stay.
pub fn delete_album(conn: &Connection, album_id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM albums WHERE id = ?1", params![album_id])?;
    Ok(())
}

/// Move-or-add under single membership: each track already in this album is left untouched; each
/// track elsewhere is unbound from its current album first; the rest are appended after the current
/// max track_no, in the given order. All in one transaction so a half-move can never persist.
pub fn add_tracks_to_album(
    conn: &mut Connection,
    album_id: i64,
    track_ids: &[i64],
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    let mut next = max_track_no(&tx, album_id)?;
    for &track_id in track_ids {
        match membership_album(&tx, track_id)? {
            Some(current) if current == album_id => continue,
            Some(_) => remove_membership(&tx, track_id)?,
            None => {}
        }
        next += 1;
        insert_album_track(&tx, album_id, track_id, next, 1)?;
    }
    tx.commit()
}

/// Removes the given tracks' membership rows from one album, in one transaction. Tracks not in the
/// album are silently skipped.
pub fn remove_tracks_from_album(
    conn: &mut Connection,
    album_id: i64,
    track_ids: &[i64],
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for &track_id in track_ids {
        tx.execute(
            "DELETE FROM album_tracks WHERE album_id = ?1 AND track_id = ?2",
            params![album_id, track_id],
        )?;
    }
    tx.commit()
}

/// Rewrites the whole track order: assigns track_no 1..N in the given order, in one transaction so
/// no intermediate numbering is ever visible. Leaves disc_no untouched.
pub fn set_track_order(
    conn: &mut Connection,
    album_id: i64,
    ordered_track_ids: &[i64],
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for (i, &track_id) in ordered_track_ids.iter().enumerate() {
        tx.execute(
            "UPDATE album_tracks SET track_no = ?1 WHERE album_id = ?2 AND track_id = ?3",
            params![(i as i64) + 1, album_id, track_id],
        )?;
    }
    tx.commit()
}

/// Replaces an album's four editable fields with the given values (a None clears its column) and
/// bumps `updated_at`.
pub fn set_album_fields(
    conn: &Connection,
    album_id: i64,
    title: Option<String>,
    album_artist: Option<String>,
    year: Option<i64>,
    genre: Option<String>,
    updated_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE albums SET title = ?1, album_artist = ?2, year = ?3, genre = ?4, updated_at = ?5
         WHERE id = ?6",
        params![title, album_artist, year, genre, updated_at, album_id],
    )?;
    Ok(())
}

/// Replaces one membership row's overrides and numbering with the given values (a None clears its
/// column). The raw source cache on the track is never touched.
pub fn set_track_overrides(
    conn: &Connection,
    album_id: i64,
    track_id: i64,
    title_override: Option<String>,
    artist_override: Option<String>,
    track_no: Option<i64>,
    disc_no: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE album_tracks
         SET title_override = ?1, artist_override = ?2, track_no = ?3, disc_no = ?4
         WHERE album_id = ?5 AND track_id = ?6",
        params![title_override, artist_override, track_no, disc_no, album_id, track_id],
    )?;
    Ok(())
}

/// Binds a cover to an album and bumps `updated_at`. The cover row is written through upsert_cover
/// first, exactly as a folder cover is.
pub fn set_album_cover(
    conn: &Connection,
    album_id: i64,
    cover_id: i64,
    updated_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE albums SET cover_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![cover_id, updated_at, album_id],
    )?;
    Ok(())
}

/// Appends one membership row with an explicit position. Private to the album writers, which own
/// the numbering.
fn insert_album_track(
    conn: &Connection,
    album_id: i64,
    track_id: i64,
    track_no: i64,
    disc_no: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO album_tracks (album_id, track_id, track_no, disc_no)
         VALUES (?1, ?2, ?3, ?4)",
        params![album_id, track_id, track_no, disc_no],
    )?;
    Ok(())
}

/// The highest track_no in an album, or 0 when it is empty. The append point is this plus one.
fn max_track_no(conn: &Connection, album_id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(MAX(track_no), 0) FROM album_tracks WHERE album_id = ?1",
        params![album_id],
        |r| r.get(0),
    )
}

/// The album a track currently belongs to, or None when it is loose. UNIQUE(track_id) guarantees
/// at most one.
fn membership_album(conn: &Connection, track_id: i64) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT album_id FROM album_tracks WHERE track_id = ?1",
        params![track_id],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Unbinds a track from whatever album holds it. A no-op when it is loose.
fn remove_membership(conn: &Connection, track_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM album_tracks WHERE track_id = ?1",
        params![track_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CoverRecord, TrackRecord};

    fn sample(scanned_at: i64) -> TrackRecord {
        TrackRecord {
            source_path: "/music/song.mp3".to_string(),
            display_path: "/music/song.mp3".to_string(),
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
    fn fresh_db_is_at_latest_version_with_tables() {
        let conn = open_in_memory().unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 4);

        for table in [
            "tracks",
            "meta",
            "covers",
            "folder_covers",
            "albums",
            "album_tracks",
            "settings",
        ] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table} should exist");
        }

        // The tri-state art column, the presence stamp, and the real-case path land on tracks.
        for col in ["has_embedded_cover", "missing_at", "display_path"] {
            let has_col: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('tracks') WHERE name = ?1",
                    params![col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has_col, 1, "tracks.{col} should exist");
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
        assert_eq!(version, 4);
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
    fn upsert_track_writes_the_real_case_display_path() {
        let conn = open_in_memory().unwrap();
        upsert_track(&conn, &sample(100)).unwrap();

        let stored: Option<String> = conn
            .query_row("SELECT display_path FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored.as_deref(), Some("/music/song.mp3"));
    }

    #[test]
    fn settings_round_trip_and_overwrite() {
        let conn = open_in_memory().unwrap();
        assert_eq!(
            get_setting(&conn, "drawer_width").unwrap(),
            None,
            "an absent key reads None",
        );

        set_setting(&conn, "drawer_width", "420").unwrap();
        assert_eq!(
            get_setting(&conn, "drawer_width").unwrap(),
            Some("420".to_string()),
        );

        // A second set on the same key replaces the value, not appends a row.
        set_setting(&conn, "drawer_width", "500").unwrap();
        assert_eq!(
            get_setting(&conn, "drawer_width").unwrap(),
            Some("500".to_string()),
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn workspace_root_reads_stored_root_or_none() {
        let conn = open_in_memory().unwrap();
        assert_eq!(
            get_workspace_root(&conn).unwrap(),
            None,
            "a fresh db has no workspace root",
        );

        conn.execute(
            "UPDATE meta SET workspace_root = ?1 WHERE id = 1",
            params!["C:\\Music"],
        )
        .unwrap();
        assert_eq!(
            get_workspace_root(&conn).unwrap(),
            Some("C:\\Music".to_string()),
        );
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
