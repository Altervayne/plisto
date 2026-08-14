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
use crate::dto::{AlbumRow, AlbumTrackRow, GenreRow, Root, TrackEdit, TrackPlacement};
use crate::model::{CoverRecord, TrackRecord};
use crate::normalize::{normalize_genre_key, normalize_path_key};

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
/// `root_id` stamps the track's origin root and is re-stamped on every pass, so a re-scan keeps
/// the association current.
pub fn upsert_track(
    conn: &Connection,
    rec: &TrackRecord,
    root_id: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tracks (
            source_path, display_path, filename, ext, size_bytes, mtime, duration_secs,
            raw_title, raw_artist, raw_album, raw_album_artist,
            raw_track_no, raw_disc_no, raw_year, raw_genre, has_embedded_cover, scanned_at, root_id
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
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
            scanned_at = excluded.scanned_at,
            root_id = excluded.root_id",
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
            root_id,
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

/// The full-res store key for a cover: its content hash (the on-disk blob name) and the original
/// byte length (a cheap integrity pre-check before hashing). None when the id is absent.
pub fn get_cover_blob_key(
    conn: &Connection,
    cover_id: i64,
) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT content_hash, byte_len FROM covers WHERE id = ?1",
        params![cover_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Every imported cover that could carry a durable full-res blob: its content hash and origin
/// path. Embedded and adjacent art never reach the manifest, so this is the imported set; the
/// origin filter drops a row whose pick path was never recorded. Feeds the one-time backfill.
pub fn imported_full_res_origins(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT content_hash, origin_path FROM covers
         WHERE source_kind = 'imported' AND origin_path IS NOT NULL",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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

// ---- Roots ----

/// Inserts a root and returns its new id. `root_key` is the folded identity (UNIQUE), `path` the
/// real-case walk anchor. The caller computes `root_key` with normalize_path_key so folding stays
/// ASCII-parity-safe.
pub fn insert_root(
    conn: &Connection,
    root_key: &str,
    path: &str,
    added_at: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO roots (root_key, path, added_at) VALUES (?1, ?2, ?3)",
        params![root_key, path, added_at],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The (id, real-case path) of the root with this folded key, or None when none matches. Backs the
/// idempotent get-or-create so a re-add of the same folder reuses its row.
pub fn get_root_by_key(
    conn: &Connection,
    root_key: &str,
) -> rusqlite::Result<Option<(i64, String)>> {
    conn.query_row(
        "SELECT id, path FROM roots WHERE root_key = ?1",
        params![root_key],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// The root for `path`, creating it when absent. Returns its (id, real-case path). Idempotent: a
/// folder already in the library returns its existing row. The single-root scan entry leans on
/// this so a re-scan of the same path never duplicates a root.
pub fn get_or_create_root(
    conn: &Connection,
    path: &str,
    added_at: i64,
) -> rusqlite::Result<(i64, String)> {
    let key = normalize_path_key(path);
    if let Some(found) = get_root_by_key(conn, &key)? {
        return Ok(found);
    }
    let id = insert_root(conn, &key, path, added_at)?;
    Ok((id, path.to_string()))
}

/// Every root with its live track count, ordered by id. The count is a LEFT JOIN so a root with no
/// indexed tracks still returns a row with a zero count.
pub fn list_roots(conn: &Connection) -> rusqlite::Result<Vec<Root>> {
    let mut stmt = conn.prepare(
        "SELECT r.id, r.path, COUNT(t.id) AS track_count
         FROM roots r
         LEFT JOIN tracks t ON t.root_id = r.id
         GROUP BY r.id
         ORDER BY r.id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Root {
                id: r.get(0)?,
                path: r.get(1)?,
                track_count: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The (id, real-case path) of one root, or None when the id is absent. The walk anchor for a
/// single-root rescan.
pub fn root_target(conn: &Connection, root_id: i64) -> rusqlite::Result<Option<(i64, String)>> {
    conn.query_row(
        "SELECT id, path FROM roots WHERE id = ?1",
        params![root_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Every root as (id, real-case path), ordered by id. The walk set for a rescan-all.
pub fn root_targets(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, path FROM roots ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every root's real-case path, ordered by id. The overlap guard and the export destination check
/// compare a candidate against all of these.
pub fn all_root_paths(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM roots ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The first root's real-case path, or None when the library is empty. The interim single-folder
/// reader until the frontend reads the whole root list.
pub fn first_root_path(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT path FROM roots ORDER BY id LIMIT 1", [], |r| {
        r.get(0)
    })
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Fills the folded `root_key` of any root that still has NULL, from its real-case path. The
/// migration seeds the first root's path in SQL but leaves its key NULL, because SQL lower() is
/// ASCII-only and would break fold-parity on non-ASCII paths; this runs the real normalize on
/// load. Idempotent: a root whose key is already set is skipped.
pub fn fill_root_keys(conn: &Connection) -> rusqlite::Result<()> {
    let pending: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, path FROM roots WHERE root_key IS NULL")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    for (id, path) in pending {
        conn.execute(
            "UPDATE roots SET root_key = ?1 WHERE id = ?2",
            params![normalize_path_key(&path), id],
        )?;
    }
    Ok(())
}

/// Removes a root and everything that hung off it, in one transaction. Deleting the root CASCADEs
/// to its tracks (root_id FK), and each dropped track CASCADEs to its album membership (track_id
/// FK). Any album or single gutted to zero members by that cascade is then deleted, restoring the
/// "every container holds at least one member" invariant.
pub fn remove_root(conn: &mut Connection, root_id: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM roots WHERE id = ?1", params![root_id])?;
    delete_emptied_albums(&tx)?;
    tx.commit()
}

/// Deletes every album or single left with no members. The emptied-container cleanup a cascade
/// needs so it never leaves a zero-track shell.
fn delete_emptied_albums(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM albums
         WHERE NOT EXISTS (SELECT 1 FROM album_tracks WHERE album_tracks.album_id = albums.id)",
        [],
    )
}

/// The blast radius of removing `root_id`, for the counted confirm. Returns
/// `(tracks, albums_losing_members, albums_emptied)`: how many indexed tracks the root holds; how
/// many albums are built partly from it (>=1 member under it and >=1 not - they shrink); and how
/// many are built entirely from it (every member under it - they get deleted). Read-only.
pub fn root_removal_impact(conn: &Connection, root_id: i64) -> rusqlite::Result<(i64, i64, i64)> {
    let tracks: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tracks WHERE root_id = ?1",
        params![root_id],
        |r| r.get(0),
    )?;

    // Albums with at least one member under this root and at least one member not under it.
    let losing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM albums a
         WHERE EXISTS (
             SELECT 1 FROM album_tracks at JOIN tracks t ON t.id = at.track_id
             WHERE at.album_id = a.id AND t.root_id = ?1)
           AND EXISTS (
             SELECT 1 FROM album_tracks at JOIN tracks t ON t.id = at.track_id
             WHERE at.album_id = a.id AND t.root_id IS NOT ?1)",
        params![root_id],
        |r| r.get(0),
    )?;

    // Albums with at least one member under this root and none outside it.
    let emptied: i64 = conn.query_row(
        "SELECT COUNT(*) FROM albums a
         WHERE EXISTS (
             SELECT 1 FROM album_tracks at JOIN tracks t ON t.id = at.track_id
             WHERE at.album_id = a.id AND t.root_id = ?1)
           AND NOT EXISTS (
             SELECT 1 FROM album_tracks at JOIN tracks t ON t.id = at.track_id
             WHERE at.album_id = a.id AND t.root_id IS NOT ?1)",
        params![root_id],
        |r| r.get(0),
    )?;

    Ok((tracks, losing, emptied))
}

// ---- Genre vocabulary ----

// The one-time marker that the album-genre vocabulary seed has run. Its presence in `settings`
// short-circuits the backfill on every later launch, so the seed happens exactly once.
const GENRE_BACKFILL_DONE: &str = "genre_backfill_done";

/// The genre row for `name`, creating it when absent, returning its id. Keyed on the folded
/// `name_key` (UNIQUE), so two spellings that fold together share one row and the first real-case
/// `name` seen wins as the display form. Mirrors get_or_create_root's fold-first identity; the key
/// is computed with normalize_genre_key so folding stays Unicode-correct, not ASCII-only SQL lower().
pub(crate) fn get_or_create_genre(
    conn: &Connection,
    name: &str,
    created_at: i64,
) -> rusqlite::Result<i64> {
    let key = normalize_genre_key(name);
    if let Some(id) = get_genre_by_key(conn, &key)? {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO genres (name, name_key, created_at) VALUES (?1, ?2, ?3)",
        params![name, key, created_at],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The id of the genre with this folded key, or None when none matches. Backs the idempotent
/// get-or-create so a fold-equal spelling reuses its row.
fn get_genre_by_key(conn: &Connection, name_key: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT id FROM genres WHERE name_key = ?1",
        params![name_key],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// Seeds the genre vocabulary from the pre-existing album-level `albums.genre` values, once, so
/// export output is unchanged after the per-track edit layer lands: every album genre becomes a real
/// per-track genre on each of that album's members, at position 1. Runs Rust-side on load rather than
/// in the migration because folding each genre to its identity key needs the real Unicode case-fold,
/// which SQL lower() cannot do - the same reason root_key is filled here. Only `albums.genre` seeds
/// the vocabulary; the junky `raw_genre` tags are deliberately left out so the curated list stays
/// clean. Guarded idempotent by a settings marker, so a second launch is a no-op; the whole seed runs
/// in one transaction under the single writer during hydration, so no partial state is ever visible.
pub fn backfill_genres_from_albums(conn: &mut Connection, now: i64) -> rusqlite::Result<()> {
    if get_setting(conn, GENRE_BACKFILL_DONE)?.is_some() {
        return Ok(());
    }

    let tx = conn.transaction()?;
    {
        // Each album carrying a real, non-blank genre: its display text drives the vocabulary.
        let albums: Vec<(i64, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, genre FROM albums WHERE genre IS NOT NULL AND TRIM(genre) <> ''",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };

        for (album_id, genre) in albums {
            let genre_id = get_or_create_genre(&tx, &genre, now)?;
            let members: Vec<i64> = {
                let mut stmt =
                    tx.prepare("SELECT track_id FROM album_tracks WHERE album_id = ?1")?;
                let rows = stmt
                    .query_map(params![album_id], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            // Seed each member at position 1; OR IGNORE skips a pair the loop has already placed.
            for track_id in members {
                tx.execute(
                    "INSERT OR IGNORE INTO track_genres (track_id, genre_id, position)
                     VALUES (?1, ?2, 1)",
                    params![track_id, genre_id],
                )?;
            }
        }
    }
    set_setting(&tx, GENRE_BACKFILL_DONE, "1")?;
    tx.commit()
}

/// Every vocabulary genre with how many tracks carry it, ordered by the folded key so the list is
/// stable and case-consistent whatever the display spelling. The LEFT JOIN keeps a never-used genre
/// in the list at a zero count. This is the whole managed vocabulary, the pool a per-track editor
/// picks from.
pub fn list_genres(conn: &Connection) -> rusqlite::Result<Vec<GenreRow>> {
    let mut stmt = conn.prepare(
        "SELECT g.id, g.name, COUNT(tg.track_id)
         FROM genres g
         LEFT JOIN track_genres tg ON tg.genre_id = g.id
         GROUP BY g.id
         ORDER BY g.name_key",
    )?;
    let rows = stmt
        .query_map([], genre_row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Maps one result row into a GenreRow: id, display name, usage count in that order.
fn genre_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<GenreRow> {
    Ok(GenreRow {
        id: r.get(0)?,
        name: r.get(1)?,
        track_count: r.get(2)?,
    })
}

/// One vocabulary genre with its usage count, by id. The single-row twin of list_genres, so a
/// writer can hand back the full row it just created or matched.
fn genre_row(conn: &Connection, id: i64) -> rusqlite::Result<GenreRow> {
    conn.query_row(
        "SELECT g.id, g.name, COUNT(tg.track_id)
         FROM genres g
         LEFT JOIN track_genres tg ON tg.genre_id = g.id
         WHERE g.id = ?1
         GROUP BY g.id",
        params![id],
        genre_row_from_sql,
    )
}

/// Creates a vocabulary genre from `name`, or returns the existing row when its folded key already
/// exists, so re-creating a known spelling reuses the row rather than duplicating. A blank or
/// whitespace-only name is rejected - the vocabulary holds no nameless entry. The count is 0 for a
/// fresh row, or the real usage count when the fold matched an existing genre.
pub fn create_genre(
    conn: &Connection,
    name: &str,
    created_at: i64,
) -> Result<GenreRow, WriteError> {
    if name.trim().is_empty() {
        return Err(WriteError::BlankGenre);
    }
    let id = get_or_create_genre(conn, name, created_at)?;
    Ok(genre_row(conn, id)?)
}

/// Renames a vocabulary genre, recomputing its folded key. When a DIFFERENT genre already owns that
/// key the rename is rejected as a collision, never silently folding the two together - merging is a
/// deliberate, separate command. A rename that folds to the row's own key (a pure case or spacing
/// change) is allowed and just refreshes the display name.
pub fn rename_genre(conn: &Connection, id: i64, name: &str) -> Result<(), WriteError> {
    if name.trim().is_empty() {
        return Err(WriteError::BlankGenre);
    }
    let key = normalize_genre_key(name);
    if let Some(existing) = get_genre_by_key(conn, &key)? {
        if existing != id {
            return Err(WriteError::GenreExists);
        }
    }
    conn.execute(
        "UPDATE genres SET name = ?1, name_key = ?2 WHERE id = ?3",
        params![name, key, id],
    )?;
    Ok(())
}

/// Deletes a vocabulary genre. Its `track_genres` rows CASCADE away, so it vanishes from every track
/// that carried it - a vocabulary-wide removal, distinct from unbinding it from one album's members.
pub fn delete_genre(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM genres WHERE id = ?1", params![id])?;
    Ok(())
}

/// How many distinct tracks carry `id`, for the counted confirm before a vocabulary-wide delete.
/// Mirrors root_removal_impact's read-only shape. Read-only.
pub fn genre_removal_impact(conn: &Connection, id: i64) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(DISTINCT track_id) FROM track_genres WHERE genre_id = ?1",
        params![id],
        |r| r.get(0),
    )
}

/// Folds `source_id` into `target_id`: repoints every track carrying the source onto the target,
/// then drops the source genre. A track already carrying the target keeps its existing row (OR
/// IGNORE), so no track ends up with the target twice; the leftover positions may be non-contiguous,
/// which the order-by-position reads tolerate. One transaction so a half-merge never persists; a
/// merge into itself is a no-op guard.
pub fn merge_genres(conn: &mut Connection, source_id: i64, target_id: i64) -> rusqlite::Result<()> {
    if source_id == target_id {
        return Ok(());
    }
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO track_genres (track_id, genre_id, position)
         SELECT track_id, ?1, position FROM track_genres WHERE genre_id = ?2",
        params![target_id, source_id],
    )?;
    tx.execute(
        "DELETE FROM track_genres WHERE genre_id = ?1",
        params![source_id],
    )?;
    tx.execute("DELETE FROM genres WHERE id = ?1", params![source_id])?;
    tx.commit()
}

/// Replaces one track's whole genre list with `genre_ids`, inserting each at position 1..N in the
/// given order. Keyed on the track alone, so it edits a loose track's genres too and the list
/// follows the track across an album move. One transaction so no partial list is ever visible. This
/// is the per-track editor's write; the album view's bulk add/remove are the other two primitives.
pub fn set_track_genres(
    conn: &Connection,
    track_id: i64,
    genre_ids: &[i64],
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM track_genres WHERE track_id = ?1",
        params![track_id],
    )?;
    for (i, &genre_id) in genre_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO track_genres (track_id, genre_id, position) VALUES (?1, ?2, ?3)",
            params![track_id, genre_id, (i as i64) + 1],
        )?;
    }
    tx.commit()
}

/// Bulk-adds `genre_id` to every member of an album, appending it after each member's existing
/// genres (position = that member's current max + 1) and skipping any member that already carries it
/// (OR IGNORE). The album view offers this as an explicit add-to-all; per-track divergence is edited
/// on the track. One transaction so the whole album lands together.
pub fn add_album_genre(
    conn: &mut Connection,
    album_id: i64,
    genre_id: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR IGNORE INTO track_genres (track_id, genre_id, position)
         SELECT at.track_id, ?1,
                (SELECT COALESCE(MAX(position), 0) + 1
                 FROM track_genres WHERE track_id = at.track_id)
         FROM album_tracks at WHERE at.album_id = ?2",
        params![genre_id, album_id],
    )?;
    tx.commit()
}

/// Bulk-removes `genre_id` from every member of an album. The remove-from-all counterpart to
/// add_album_genre; a member that never carried it is left untouched. One transaction.
pub fn remove_album_genre(
    conn: &mut Connection,
    album_id: i64,
    genre_id: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM track_genres
         WHERE genre_id = ?1
           AND track_id IN (SELECT track_id FROM album_tracks WHERE album_id = ?2)",
        params![genre_id, album_id],
    )?;
    tx.commit()
}

/// Every managed genre membership across the whole library as `(track_id, genre_id)`, ordered by
/// track then position so a track's genres arrive in their display order. load_organization groups
/// these into a per-track list and attaches them to the flat membership rows, keeping the SQL
/// projection free of a joined-array column. Deterministic order, never HashMap iteration.
pub fn load_track_genre_ids(conn: &Connection) -> rusqlite::Result<Vec<(i64, i64)>> {
    let mut stmt =
        conn.prepare("SELECT track_id, genre_id FROM track_genres ORDER BY track_id, position")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The managed genre memberships for a set of tracks as `(track_id, genre_id)`, ordered by track
/// then position so each track's genres arrive in display order. list_tracks attaches these to the
/// window it just read, scoping the read to the returned ids rather than the whole library. An empty
/// `track_ids` returns nothing without touching the database. Deterministic order, never HashMap
/// iteration.
pub fn load_track_genre_ids_for(
    conn: &Connection,
    track_ids: &[i64],
) -> rusqlite::Result<Vec<(i64, i64)>> {
    if track_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; track_ids.len()].join(", ");
    let sql = format!(
        "SELECT track_id, genre_id FROM track_genres WHERE track_id IN ({placeholders}) \
         ORDER BY track_id, position"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(track_ids.iter()), |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ---- Albums and membership ----

// The two album kinds. A plain album groups many tracks; a single is an album-of-one that earns
// its own release fields and cover. Both live in `albums`, partitioned by this column.
pub const ALBUM_KIND: &str = "album";
pub const SINGLE_KIND: &str = "single";

/// A write rejected by an album invariant the schema itself cannot express: a single is an
/// album-of-one, so its membership is exactly one track and nothing more may be appended. Wraps a
/// plain SQL error so a writer can fail either way through one Result.
#[derive(Debug)]
pub enum WriteError {
    Sql(rusqlite::Error),
    // A single was asked to hold other than exactly one track.
    SingleMember,
    // A track was assigned to an album that is a single.
    AddToSingle,
    // A genre was created or renamed to a blank name; the vocabulary holds no nameless entry.
    BlankGenre,
    // A rename would fold to a key another genre already owns; merging is a separate, explicit act.
    GenreExists,
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Sql(e) => write!(f, "{e}"),
            WriteError::SingleMember => write!(f, "a single must hold exactly one track"),
            WriteError::AddToSingle => write!(f, "a single cannot take another track"),
            WriteError::BlankGenre => write!(f, "a genre name cannot be blank"),
            WriteError::GenreExists => write!(f, "a genre with that name already exists"),
        }
    }
}

impl From<rusqlite::Error> for WriteError {
    fn from(e: rusqlite::Error) -> Self {
        WriteError::Sql(e)
    }
}

// The album projection with its live track count. LEFT JOIN so an empty album still returns a row
// with a zero count. Callers append the GROUP BY and, for a single album, a WHERE.
const ALBUM_SELECT: &str = "
    SELECT a.id, a.title, a.album_artist, a.year, a.genre, a.cover_id, a.kind,
           COUNT(at.track_id) AS track_count, a.created_at, a.updated_at
    FROM albums a
    LEFT JOIN album_tracks at ON at.album_id = a.id";

// The drawer's membership projection: the immutable source fields joined from `tracks` beside the
// per-track edits, which now live on `track_edits` (keyed on the track alone) rather than the old
// `album_tracks` override columns. The title/artist edits fill the `title_override`/`artist_override`
// slots the frontend already resolves against; disc is coalesced in SQL to `track_edits.disc_no ??
// raw_disc_no`, so the flat row exposes the resolved disc with no extra column. Only `track_no` still
// comes from `album_tracks`, since numbering is membership position, not an edit. Callers append the
// ORDER BY.
const ALBUM_TRACK_SELECT: &str = "
    SELECT at.album_id, at.track_id, t.source_path, t.filename, t.duration_secs,
           at.track_no, COALESCE(te.disc_no, t.raw_disc_no), t.raw_title, t.raw_artist,
           te.title, te.artist, t.has_embedded_cover, t.missing_at
    FROM album_tracks at
    JOIN tracks t ON t.id = at.track_id
    LEFT JOIN track_edits te ON te.track_id = at.track_id";

/// One membership row shaped for export: the source paths and extension joined from `tracks`
/// beside the per-track edits from `track_edits` and the membership numbering from `album_tracks`,
/// plus the presence stamp and the tri-state art flag. `display_path` is the real-case path to
/// open; `source_path` is the folded fallback used only when a legacy row never captured a display
/// path. The edit-layer title/artist land in the `title_override`/`artist_override` slots and
/// resolve to the effective value through `resolve.rs`, exactly as the read path does; `disc_no` is
/// already the resolved `track_edits.disc_no ?? raw_disc_no`, coalesced in SQL. The album,
/// album_artist and year edits ride along raw as `*_override`: the plan resolves each against its
/// container's value, so an un-edited track inherits the album's while an edited one wins. Purpose-
/// built because AlbumTrackRow carries no `ext` or `display_path`.
#[derive(Debug, Clone)]
pub struct ExportTrackRow {
    pub album_id: i64,
    pub track_id: i64,
    pub display_path: Option<String>,
    pub source_path: String,
    pub ext: String,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub raw_title: Option<String>,
    pub raw_artist: Option<String>,
    pub title_override: Option<String>,
    pub artist_override: Option<String>,
    pub album_override: Option<String>,
    pub album_artist_override: Option<String>,
    pub year_override: Option<i64>,
    pub has_embedded_cover: Option<bool>,
    pub missing_at: Option<i64>,
}

// The export projection: the source paths, extension, presence and art flags joined from `tracks`
// beside the per-track edits from `track_edits` and the membership numbering from `album_tracks`.
// The title/artist edits fill the override slots the plan resolves against; disc is coalesced in
// SQL to `track_edits.disc_no ?? raw_disc_no`, so the exported disc follows the edit layer over the
// raw scan value. The album/album_artist/year edits ride along raw so the plan can resolve each
// against its container's value. Ordered by album then track number so a container's tracks arrive
// in play order and a null track_no lands last.
const EXPORT_TRACK_SELECT: &str = "
    SELECT at.album_id, at.track_id, t.display_path, t.source_path, t.ext,
           at.track_no, COALESCE(te.disc_no, t.raw_disc_no), t.raw_title, t.raw_artist,
           te.title, te.artist, te.album, te.album_artist, te.year,
           t.has_embedded_cover, t.missing_at
    FROM album_tracks at
    JOIN tracks t ON t.id = at.track_id
    LEFT JOIN track_edits te ON te.track_id = at.track_id
    ORDER BY at.album_id, at.track_no";

/// Maps one result row into an ExportTrackRow. The column order matches EXPORT_TRACK_SELECT.
fn export_track_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<ExportTrackRow> {
    Ok(ExportTrackRow {
        album_id: r.get(0)?,
        track_id: r.get(1)?,
        display_path: r.get(2)?,
        source_path: r.get(3)?,
        ext: r.get(4)?,
        track_no: r.get(5)?,
        disc_no: r.get(6)?,
        raw_title: r.get(7)?,
        raw_artist: r.get(8)?,
        title_override: r.get(9)?,
        artist_override: r.get(10)?,
        album_override: r.get(11)?,
        album_artist_override: r.get(12)?,
        year_override: r.get(13)?,
        has_embedded_cover: r.get(14)?,
        missing_at: r.get(15)?,
    })
}

/// Every membership row across all albums and singles, shaped for export and ordered by album then
/// track number. The export plan groups these by album against the album rows.
pub fn load_export_tracks(conn: &Connection) -> rusqlite::Result<Vec<ExportTrackRow>> {
    let mut stmt = conn.prepare(EXPORT_TRACK_SELECT)?;
    let rows = stmt
        .query_map([], export_track_row_from_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Every managed genre membership across the whole library as `(track_id, genre_name)`, ordered by
/// track then position so a track's genres arrive in their display order. The export plan groups
/// these into a per-track list; the deterministic order is what keeps a re-export byte-identical, so
/// this never leans on HashMap iteration order. The join drops any dangling membership whose genre
/// row is gone, though the CASCADE should leave none.
pub fn load_export_track_genres(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT tg.track_id, g.name
         FROM track_genres tg
         JOIN genres g ON g.id = tg.genre_id
         ORDER BY tg.track_id, tg.position",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Maps one result row into an AlbumRow. The column order matches ALBUM_SELECT.
fn album_row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<AlbumRow> {
    Ok(AlbumRow {
        id: r.get(0)?,
        title: r.get(1)?,
        album_artist: r.get(2)?,
        year: r.get(3)?,
        genre: r.get(4)?,
        cover_id: r.get(5)?,
        kind: r.get(6)?,
        track_count: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
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
        // The flat projection stays genre-free; load_organization attaches the ordered ids from
        // load_track_genre_ids, so an unattached row reads as no genres rather than a wrong list.
        genre_ids: Vec::new(),
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

/// Inserts an album of the given `kind` and appends `track_ids` as membership rows in order
/// (track_no 1..N, disc_no 1) in one transaction, then returns the new row. A single is rejected
/// unless its membership is exactly one track. `cover_id` is the caller's create-time pre-fill (a
/// shared folder cover) or None. `created_at` and `updated_at` both take `now`.
pub fn create_album(
    conn: &mut Connection,
    title: Option<String>,
    album_artist: Option<String>,
    year: Option<i64>,
    genre: Option<String>,
    cover_id: Option<i64>,
    track_ids: &[i64],
    kind: &str,
    now: i64,
) -> Result<AlbumRow, WriteError> {
    if kind == SINGLE_KIND && track_ids.len() != 1 {
        return Err(WriteError::SingleMember);
    }

    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO albums (title, album_artist, year, genre, cover_id, kind, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![title, album_artist, year, genre, cover_id, kind, now],
    )?;
    let album_id = tx.last_insert_rowid();
    for (i, &track_id) in track_ids.iter().enumerate() {
        insert_album_track(&tx, album_id, track_id, (i as i64) + 1, 1)?;
    }
    tx.commit()?;

    Ok(get_album(conn, album_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?)
}

/// Promotes one loose track into a single: an album-of-one with kind='single', its release fields
/// seeded from the track's raw tags. Title takes the raw title, else the filename stem, so a single
/// always has a name; album_artist takes the raw album-artist, else the raw artist; year and genre
/// carry over. The single's title is the SONG's title, never the track's raw album tag.
pub fn create_single(
    conn: &mut Connection,
    track_id: i64,
    now: i64,
) -> Result<AlbumRow, WriteError> {
    let seed = single_seed(conn, track_id)?;
    create_album(
        conn,
        seed.title,
        seed.album_artist,
        seed.year,
        seed.genre,
        None,
        &[track_id],
        SINGLE_KIND,
        now,
    )
}

/// The release-field seeds a new single takes from its track's raw tags.
struct SingleSeed {
    title: Option<String>,
    album_artist: Option<String>,
    year: Option<i64>,
    genre: Option<String>,
}

/// Reads the seed fields for a single from its track's raw tags. Title falls back to the filename
/// stem so a single is never nameless; album_artist falls back to the raw track artist.
fn single_seed(conn: &Connection, track_id: i64) -> rusqlite::Result<SingleSeed> {
    conn.query_row(
        "SELECT raw_title, raw_album_artist, raw_artist, raw_year, raw_genre, filename
         FROM tracks WHERE id = ?1",
        params![track_id],
        |r| {
            let raw_title: Option<String> = r.get(0)?;
            let raw_album_artist: Option<String> = r.get(1)?;
            let raw_artist: Option<String> = r.get(2)?;
            let filename: String = r.get(5)?;
            Ok(SingleSeed {
                title: raw_title.or_else(|| Some(filename_stem(&filename))),
                album_artist: raw_album_artist.or(raw_artist),
                year: r.get(3)?,
                genre: r.get(4)?,
            })
        },
    )
}

/// The filename with its final extension dropped, or the whole name when it has none. The fallback
/// title for a single whose track carries no raw title.
fn filename_stem(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string())
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
) -> Result<(), WriteError> {
    let tx = conn.transaction()?;
    if album_kind(&tx, album_id)?.as_deref() == Some(SINGLE_KIND) {
        return Err(WriteError::AddToSingle);
    }
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
    Ok(tx.commit()?)
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

/// Rewrites an album's disc grouping and per-disc numbering in one atomic pass. For each placement,
/// sets the membership position on `album_tracks` and upserts the disc into `track_edits`, keyed on
/// the track alone so it follows the track across an album move. The disc upsert touches only
/// disc_no, leaving title/artist/album/etc. intact, the way set_track_overrides and set_track_edit
/// coexist. A None disc_no clears back to the raw scan through the resolver; a None track_no sorts
/// last. All in one transaction so a disc change and its renumbering are never seen half-applied.
/// `strftime` stamps each edit's `updated_at` the way the migration does.
pub fn set_album_layout(
    conn: &mut Connection,
    album_id: i64,
    placements: &[TrackPlacement],
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for p in placements {
        tx.execute(
            "UPDATE album_tracks SET track_no = ?1 WHERE album_id = ?2 AND track_id = ?3",
            params![p.track_no, album_id, p.track_id],
        )?;
        tx.execute(
            "INSERT INTO track_edits (track_id, disc_no, updated_at)
             VALUES (?1, ?2, strftime('%s', 'now'))
             ON CONFLICT(track_id) DO UPDATE SET
                 disc_no = excluded.disc_no,
                 updated_at = excluded.updated_at",
            params![p.track_id, p.disc_no],
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

/// Splits one membership edit across the two layers it now lives in. The title, artist and disc
/// edits upsert into `track_edits`, keyed on the track alone so they follow it across an album move;
/// `track_no` stays the membership position on `album_tracks`, since numbering is not an edit. A
/// None clears its column (title/artist/disc then fall back to the raw scan through the resolver, a
/// null track_no sorts last). The raw source cache on the track is never touched. Both writes run in
/// one transaction so a half-applied edit is never visible, and `strftime` stamps the edit's
/// `updated_at` the way the migration does, keeping the signature free of a clock parameter.
pub fn set_track_overrides(
    conn: &Connection,
    album_id: i64,
    track_id: i64,
    title_override: Option<String>,
    artist_override: Option<String>,
    track_no: Option<i64>,
    disc_no: Option<i64>,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO track_edits (track_id, title, artist, disc_no, updated_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
         ON CONFLICT(track_id) DO UPDATE SET
             title = excluded.title,
             artist = excluded.artist,
             disc_no = excluded.disc_no,
             updated_at = excluded.updated_at",
        params![track_id, title_override, artist_override, disc_no],
    )?;
    tx.execute(
        "UPDATE album_tracks SET track_no = ?1 WHERE album_id = ?2 AND track_id = ?3",
        params![track_no, album_id, track_id],
    )?;
    tx.commit()
}

/// The Files-view full edit of one track: a full-set upsert of all six value columns on
/// `track_edits`, keyed on the track alone. A None clears its column, so an edit falls back to the
/// raw scan through the resolver. Unlike set_track_overrides, this owns album/album_artist/year too
/// and never touches `album_tracks`: it edits a loose track just as well as a member, and numbering
/// is not part of a metadata edit. The two writers of `track_edits` coexist by design - the album
/// drawer's set_track_overrides updates only title/artist/disc and leaves album/album_artist/year
/// intact, while this Files-view edit sets the whole row. `strftime` stamps `updated_at` the way the
/// migration does, keeping the signature free of a clock parameter.
#[allow(clippy::too_many_arguments)]
pub fn set_track_edit(
    conn: &Connection,
    track_id: i64,
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    year: Option<i64>,
    disc_no: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO track_edits (track_id, title, artist, album, album_artist, year, disc_no, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%s', 'now'))
         ON CONFLICT(track_id) DO UPDATE SET
             title = excluded.title,
             artist = excluded.artist,
             album = excluded.album,
             album_artist = excluded.album_artist,
             year = excluded.year,
             disc_no = excluded.disc_no,
             updated_at = excluded.updated_at",
        params![track_id, title, artist, album, album_artist, year, disc_no],
    )?;
    Ok(())
}

/// Hydrates the Files-view editor for one track: its raw edit-layer overrides beside its ordered
/// genres. The `track_edits` row supplies the value fields, all None when the track has no row (a
/// pristine track); the genres come from `track_genres` in position order, empty when it carries
/// none. These are the raw edit values, not resolved against the raw scan - the frontend holds raw
/// already and resolves for display itself.
pub fn get_track_edit(conn: &Connection, track_id: i64) -> rusqlite::Result<TrackEdit> {
    let edit = conn
        .query_row(
            "SELECT title, artist, album, album_artist, year, disc_no
             FROM track_edits WHERE track_id = ?1",
            params![track_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })?;
    let (title, artist, album, album_artist, year, disc_no) =
        edit.unwrap_or((None, None, None, None, None, None));

    let mut stmt =
        conn.prepare("SELECT genre_id FROM track_genres WHERE track_id = ?1 ORDER BY position")?;
    let genre_ids = stmt
        .query_map(params![track_id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<i64>>>()?;

    Ok(TrackEdit {
        title,
        artist,
        album,
        album_artist,
        year,
        disc_no,
        genre_ids,
    })
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

/// The kind of an album ('album' or 'single'), or None when the id is absent. The add-to-album
/// writer reads it to reject appending to a single.
fn album_kind(conn: &Connection, album_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT kind FROM albums WHERE id = ?1",
        params![album_id],
        |r| r.get(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
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
        assert_eq!(version, 7);

        for table in [
            "tracks",
            "meta",
            "covers",
            "folder_covers",
            "albums",
            "album_tracks",
            "settings",
            "roots",
            "track_edits",
            "genres",
            "track_genres",
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

        // The tri-state art column, the presence stamp, the real-case path, and the origin root
        // land on tracks.
        for col in [
            "has_embedded_cover",
            "missing_at",
            "display_path",
            "root_id",
        ] {
            let has_col: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('tracks') WHERE name = ?1",
                    params![col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(has_col, 1, "tracks.{col} should exist");
        }

        // The album kind partitions plain albums from singles.
        let has_kind: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('albums') WHERE name = 'kind'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_kind, 1, "albums.kind should exist");
    }

    #[test]
    fn migrating_a_current_db_is_a_noop() {
        let conn = open_in_memory().unwrap();
        // A second run must not error and must leave the version untouched.
        migrations::migrate(&conn).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, 7);
    }

    #[test]
    fn upsert_is_idempotent_on_same_path() {
        let conn = open_in_memory().unwrap();
        let rec = sample(100);

        upsert_track(&conn, &rec, None).unwrap();
        upsert_track(&conn, &rec, None).unwrap();

        assert_eq!(count_rows(&conn), 1);
    }

    #[test]
    fn rescan_updates_in_place_keeping_id() {
        let conn = open_in_memory().unwrap();

        let first = sample(100);
        upsert_track(&conn, &first, None).unwrap();
        let id_before: i64 = conn
            .query_row("SELECT id FROM tracks", [], |r| r.get(0))
            .unwrap();

        // Same path, changed mtime and a later scan clock: one row, same id, fields advance.
        let mut second = sample(200);
        second.mtime = 3000;
        upsert_track(&conn, &second, None).unwrap();

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
        upsert_track(&conn, &rec, None).unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT has_embedded_cover FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, None, "None persists as NULL");

        rec.has_embedded_cover = Some(false);
        upsert_track(&conn, &rec, None).unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT has_embedded_cover FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, Some(0), "Some(false) persists as 0");

        rec.has_embedded_cover = Some(true);
        upsert_track(&conn, &rec, None).unwrap();
        let stored: Option<i64> = conn
            .query_row("SELECT has_embedded_cover FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stored, Some(1), "Some(true) persists as 1");
    }

    #[test]
    fn upsert_track_writes_the_real_case_display_path() {
        let conn = open_in_memory().unwrap();
        upsert_track(&conn, &sample(100), None).unwrap();

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
    fn first_root_path_reads_the_first_root_or_none() {
        let conn = open_in_memory().unwrap();
        assert_eq!(
            first_root_path(&conn).unwrap(),
            None,
            "a fresh db has no roots",
        );

        let (_, path) = get_or_create_root(&conn, "C:\\Music", 10).unwrap();
        assert_eq!(path, "C:\\Music");
        assert_eq!(
            first_root_path(&conn).unwrap(),
            Some("C:\\Music".to_string()),
        );
    }

    #[test]
    fn get_or_create_root_is_idempotent_on_the_folded_key() {
        let conn = open_in_memory().unwrap();
        let (first, _) = get_or_create_root(&conn, "C:\\Music", 10).unwrap();

        // A re-add under different casing folds to the same key and reuses the row on Windows.
        let (again, _) = get_or_create_root(&conn, "c:\\music", 20).unwrap();
        if cfg!(windows) {
            assert_eq!(first, again, "a case-different re-add reuses the root");
        }

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM roots", [], |r| r.get(0))
            .unwrap();
        if cfg!(windows) {
            assert_eq!(count, 1);
        }
    }

    #[test]
    fn fill_root_keys_fills_null_keys_from_the_path() {
        let conn = open_in_memory().unwrap();
        // A migration-seeded root has a path but a NULL key.
        conn.execute(
            "INSERT INTO roots (root_key, path, added_at) VALUES (NULL, 'C:\\Music', 5)",
            [],
        )
        .unwrap();

        fill_root_keys(&conn).unwrap();

        let key: Option<String> = conn
            .query_row("SELECT root_key FROM roots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            key.as_deref(),
            Some(normalize_path_key("C:\\Music").as_str())
        );

        // Idempotent: a second run leaves the already-filled key untouched.
        fill_root_keys(&conn).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM roots WHERE root_key IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn list_roots_reports_per_root_track_counts() {
        let conn = open_in_memory().unwrap();
        let (a, _) = get_or_create_root(&conn, "/music/a", 1).unwrap();
        let (b, _) = get_or_create_root(&conn, "/music/b", 1).unwrap();

        let mut ra = sample(1);
        ra.source_path = "/music/a/1.mp3".to_string();
        upsert_track(&conn, &ra, Some(a)).unwrap();
        let mut ra2 = sample(1);
        ra2.source_path = "/music/a/2.mp3".to_string();
        upsert_track(&conn, &ra2, Some(a)).unwrap();
        let mut rb = sample(1);
        rb.source_path = "/music/b/1.mp3".to_string();
        upsert_track(&conn, &rb, Some(b)).unwrap();

        let roots = list_roots(&conn).unwrap();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].track_count, 2, "root a holds two tracks");
        assert_eq!(roots[1].track_count, 1, "root b holds one track");
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

    #[test]
    fn create_single_seeds_release_fields_from_raw_tags() {
        let mut conn = open_in_memory().unwrap();
        upsert_track(&conn, &sample(100), None).unwrap();
        let track_id: i64 = conn
            .query_row("SELECT id FROM tracks", [], |r| r.get(0))
            .unwrap();

        let single = create_single(&mut conn, track_id, 200).unwrap();

        assert_eq!(single.kind, "single", "a single carries kind='single'");
        assert_eq!(
            single.track_count, 1,
            "a single holds exactly its one track"
        );
        assert_eq!(
            single.title.as_deref(),
            Some("Song"),
            "title from raw_title"
        );
        assert_eq!(
            single.album_artist.as_deref(),
            Some("Artist"),
            "album_artist falls back to raw_artist when raw_album_artist is unset",
        );
        assert_eq!(single.year, Some(1997), "year carries over");
        assert_eq!(single.genre, None, "an unset genre stays unset");
    }

    #[test]
    fn create_single_title_falls_back_to_filename_stem() {
        let mut conn = open_in_memory().unwrap();
        let mut rec = sample(100);
        rec.raw_title = None;
        upsert_track(&conn, &rec, None).unwrap();
        let track_id: i64 = conn
            .query_row("SELECT id FROM tracks", [], |r| r.get(0))
            .unwrap();

        let single = create_single(&mut conn, track_id, 200).unwrap();
        assert_eq!(
            single.title.as_deref(),
            Some("song"),
            "a titleless track seeds the stem of song.mp3",
        );
    }

    #[test]
    fn create_album_rejects_a_single_without_exactly_one_member() {
        let mut conn = open_in_memory().unwrap();
        let mut a = sample(100);
        a.source_path = "/music/a.mp3".to_string();
        let mut b = sample(100);
        b.source_path = "/music/b.mp3".to_string();
        upsert_track(&conn, &a, None).unwrap();
        upsert_track(&conn, &b, None).unwrap();
        let ids: Vec<i64> = conn
            .prepare("SELECT id FROM tracks ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        let two = create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &ids,
            SINGLE_KIND,
            1,
        );
        assert!(
            matches!(two, Err(WriteError::SingleMember)),
            "a two-track single is rejected",
        );
        let zero = create_album(&mut conn, None, None, None, None, None, &[], SINGLE_KIND, 1);
        assert!(
            matches!(zero, Err(WriteError::SingleMember)),
            "an empty single is rejected",
        );

        let none: i64 = conn
            .query_row("SELECT COUNT(*) FROM albums", [], |r| r.get(0))
            .unwrap();
        assert_eq!(none, 0, "a rejected single writes no album row");
    }

    // Inserts a track at `path` stamped with `root_id` and returns its id.
    fn track_under(conn: &Connection, path: &str, root_id: i64) -> i64 {
        let mut rec = sample(1);
        rec.source_path = path.to_string();
        upsert_track(conn, &rec, Some(root_id)).unwrap();
        conn.query_row(
            "SELECT id FROM tracks WHERE source_path = ?1",
            params![path],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn remove_root_drops_tracks_and_empties_or_shrinks_albums() {
        let mut conn = open_in_memory().unwrap();
        let (a, _) = get_or_create_root(&conn, "/music/a", 1).unwrap();
        let (b, _) = get_or_create_root(&conn, "/music/b", 1).unwrap();

        let a1 = track_under(&conn, "/music/a/1.mp3", a);
        let a2 = track_under(&conn, "/music/a/2.mp3", a);
        let b1 = track_under(&conn, "/music/b/1.mp3", b);

        // One album mixes both roots; one is built entirely from root A.
        let shared = create_album(
            &mut conn,
            Some("shared".into()),
            None,
            None,
            None,
            None,
            &[a1, b1],
            ALBUM_KIND,
            1,
        )
        .unwrap();
        let a_only = create_album(
            &mut conn,
            Some("a only".into()),
            None,
            None,
            None,
            None,
            &[a2],
            ALBUM_KIND,
            1,
        )
        .unwrap();

        remove_root(&mut conn, a).unwrap();

        // Root A's tracks are cascaded away; root B's survives.
        let remaining: Vec<i64> = conn
            .prepare("SELECT id FROM tracks ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(remaining, vec![b1], "only root B's track survives");

        // The all-from-A album is deleted; the shared album survives, shrunk to its B member.
        assert!(
            get_album(&conn, a_only.id).unwrap().is_none(),
            "the emptied album is deleted",
        );
        let shared_row = get_album(&conn, shared.id)
            .unwrap()
            .expect("the shared album survives");
        assert_eq!(
            shared_row.track_count, 1,
            "the shared album shrinks to its surviving member",
        );
    }

    #[test]
    fn root_removal_impact_counts_partial_and_entire_albums() {
        let mut conn = open_in_memory().unwrap();
        let (a, _) = get_or_create_root(&conn, "/music/a", 1).unwrap();
        let (b, _) = get_or_create_root(&conn, "/music/b", 1).unwrap();

        let a1 = track_under(&conn, "/music/a/1.mp3", a);
        let a2 = track_under(&conn, "/music/a/2.mp3", a);
        let a3 = track_under(&conn, "/music/a/3.mp3", a);
        let b1 = track_under(&conn, "/music/b/1.mp3", b);

        // shared is partly from A; a_only is entirely from A.
        create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[a1, b1],
            ALBUM_KIND,
            1,
        )
        .unwrap();
        create_album(
            &mut conn,
            None,
            None,
            None,
            None,
            None,
            &[a2, a3],
            ALBUM_KIND,
            1,
        )
        .unwrap();

        let (tracks, losing, emptied) = root_removal_impact(&conn, a).unwrap();
        assert_eq!(tracks, 3, "root A holds three tracks");
        assert_eq!(losing, 1, "one album is built partly from A");
        assert_eq!(emptied, 1, "one album is built entirely from A");
    }

    #[test]
    fn backfill_genres_seeds_deduped_vocabulary_and_is_idempotent() {
        let mut conn = open_in_memory().unwrap();
        let mut a = sample(1);
        a.source_path = "/music/a.mp3".to_string();
        upsert_track(&conn, &a, None).unwrap();
        let mut b = sample(1);
        b.source_path = "/music/b.mp3".to_string();
        upsert_track(&conn, &b, None).unwrap();
        let ids: Vec<i64> = conn
            .prepare("SELECT id FROM tracks ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let (t1, t2) = (ids[0], ids[1]);

        // Two albums whose genres are case-variants that fold to one identity.
        create_album(
            &mut conn,
            Some("A".into()),
            None,
            None,
            Some("Rock".into()),
            None,
            &[t1],
            ALBUM_KIND,
            1,
        )
        .unwrap();
        create_album(
            &mut conn,
            Some("B".into()),
            None,
            None,
            Some("rock".into()),
            None,
            &[t2],
            ALBUM_KIND,
            1,
        )
        .unwrap();

        backfill_genres_from_albums(&mut conn, 100).unwrap();

        // The vocabulary deduped to the one folded genre.
        let genres: i64 = conn
            .query_row("SELECT COUNT(*) FROM genres", [], |r| r.get(0))
            .unwrap();
        assert_eq!(genres, 1, "the two case-variants fold to one genre");
        let gid: i64 = conn
            .query_row("SELECT id FROM genres", [], |r| r.get(0))
            .unwrap();

        // Every member got its genre row at position 1, pointing at the deduped genre.
        let rows: Vec<(i64, i64, i64)> = conn
            .prepare("SELECT track_id, genre_id, position FROM track_genres ORDER BY track_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(rows.len(), 2, "each album member got a genre row");
        assert!(rows.iter().all(|&(_, g, pos)| g == gid && pos == 1));

        // Idempotent: a second run adds nothing, the marker short-circuits it.
        backfill_genres_from_albums(&mut conn, 200).unwrap();
        let genres_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM genres", [], |r| r.get(0))
            .unwrap();
        let memberships_after: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_genres", [], |r| r.get(0))
            .unwrap();
        assert_eq!(genres_after, 1, "a second run adds no genre");
        assert_eq!(memberships_after, 2, "a second run adds no membership");
    }

    // Inserts a bare track at `path` and returns its id, for the per-track genre tests.
    fn genre_track(conn: &Connection, path: &str) -> i64 {
        let mut rec = sample(1);
        rec.source_path = path.to_string();
        upsert_track(conn, &rec, None).unwrap();
        conn.query_row(
            "SELECT id FROM tracks WHERE source_path = ?1",
            params![path],
            |r| r.get(0),
        )
        .unwrap()
    }

    // A track's genre ids in stored position order.
    fn genre_ids_of(conn: &Connection, track_id: i64) -> Vec<i64> {
        conn.prepare("SELECT genre_id FROM track_genres WHERE track_id = ?1 ORDER BY position")
            .unwrap()
            .query_map(params![track_id], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn create_genre_dedups_on_the_folded_key() {
        let conn = open_in_memory().unwrap();
        let first = create_genre(&conn, "Rock", 1).unwrap();
        // A case-variant folds to the same key and returns the existing row, not a duplicate.
        let again = create_genre(&conn, "rock", 2).unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(
            again.name, "Rock",
            "the first spelling stays the display form"
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM genres", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn create_genre_rejects_a_blank_name() {
        let conn = open_in_memory().unwrap();
        assert!(matches!(
            create_genre(&conn, "   ", 1),
            Err(WriteError::BlankGenre)
        ));
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM genres", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "a blank name writes no row");
    }

    #[test]
    fn rename_genre_rejects_a_collision_but_allows_a_case_change() {
        let conn = open_in_memory().unwrap();
        let rock = create_genre(&conn, "Rock", 1).unwrap();
        let pop = create_genre(&conn, "Pop", 1).unwrap();

        // Renaming Pop to a spelling that folds onto Rock is rejected, never a silent merge.
        assert!(matches!(
            rename_genre(&conn, pop.id, "rock"),
            Err(WriteError::GenreExists)
        ));

        // Renaming Rock to its own case-variant is allowed and just refreshes the display name.
        rename_genre(&conn, rock.id, "ROCK").unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM genres WHERE id = ?1",
                params![rock.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "ROCK");
    }

    #[test]
    fn delete_genre_cascades_off_every_track() {
        let conn = open_in_memory().unwrap();
        let t = genre_track(&conn, "/music/1.mp3");
        let g = create_genre(&conn, "Rock", 1).unwrap();
        set_track_genres(&conn, t, &[g.id]).unwrap();
        assert_eq!(genre_ids_of(&conn, t), vec![g.id]);

        delete_genre(&conn, g.id).unwrap();
        assert!(
            genre_ids_of(&conn, t).is_empty(),
            "the membership cascades away with the genre",
        );
    }

    #[test]
    fn merge_genres_repoints_tracks_and_dedups() {
        let mut conn = open_in_memory().unwrap();
        let t1 = genre_track(&conn, "/music/1.mp3");
        let t2 = genre_track(&conn, "/music/2.mp3");
        let src = create_genre(&conn, "Hip Hop", 1).unwrap();
        let dst = create_genre(&conn, "Rap", 1).unwrap();

        // t1 carries only the source; t2 already carries the target beside the source.
        set_track_genres(&conn, t1, &[src.id]).unwrap();
        set_track_genres(&conn, t2, &[dst.id, src.id]).unwrap();

        merge_genres(&mut conn, src.id, dst.id).unwrap();

        // t1 now carries the target; t2 keeps its single target row, no duplicate.
        assert_eq!(genre_ids_of(&conn, t1), vec![dst.id]);
        assert_eq!(genre_ids_of(&conn, t2), vec![dst.id]);
        let source_left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM genres WHERE id = ?1",
                params![src.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source_left, 0, "the source genre is deleted");
    }

    #[test]
    fn set_track_genres_replaces_the_whole_list() {
        let conn = open_in_memory().unwrap();
        let t = genre_track(&conn, "/music/1.mp3");
        let a = create_genre(&conn, "A", 1).unwrap();
        let b = create_genre(&conn, "B", 1).unwrap();
        let c = create_genre(&conn, "C", 1).unwrap();

        set_track_genres(&conn, t, &[a.id, b.id]).unwrap();
        assert_eq!(genre_ids_of(&conn, t), vec![a.id, b.id]);

        // A second set replaces rather than appends, and keeps the given order.
        set_track_genres(&conn, t, &[c.id, a.id]).unwrap();
        assert_eq!(genre_ids_of(&conn, t), vec![c.id, a.id]);
    }

    #[test]
    fn add_and_remove_album_genre_hit_all_members() {
        let mut conn = open_in_memory().unwrap();
        let t1 = genre_track(&conn, "/music/1.mp3");
        let t2 = genre_track(&conn, "/music/2.mp3");
        let album = create_album(
            &mut conn,
            Some("T".into()),
            None,
            None,
            None,
            None,
            &[t1, t2],
            ALBUM_KIND,
            1,
        )
        .unwrap();
        let g = create_genre(&conn, "Rock", 1).unwrap();

        add_album_genre(&mut conn, album.id, g.id).unwrap();
        assert_eq!(genre_ids_of(&conn, t1), vec![g.id]);
        assert_eq!(genre_ids_of(&conn, t2), vec![g.id]);

        // Adding again is a no-op on members that already carry it.
        add_album_genre(&mut conn, album.id, g.id).unwrap();
        assert_eq!(genre_ids_of(&conn, t1), vec![g.id]);

        remove_album_genre(&mut conn, album.id, g.id).unwrap();
        assert!(genre_ids_of(&conn, t1).is_empty());
        assert!(genre_ids_of(&conn, t2).is_empty());
    }

    #[test]
    fn list_genres_reports_usage_counts_ordered_by_key() {
        let conn = open_in_memory().unwrap();
        let t1 = genre_track(&conn, "/music/1.mp3");
        let t2 = genre_track(&conn, "/music/2.mp3");
        let rock = create_genre(&conn, "Rock", 1).unwrap();
        let jazz = create_genre(&conn, "Jazz", 1).unwrap();

        set_track_genres(&conn, t1, &[rock.id]).unwrap();
        set_track_genres(&conn, t2, &[rock.id]).unwrap();

        let genres = list_genres(&conn).unwrap();
        assert_eq!(genres.len(), 2);
        let rock_row = genres.iter().find(|g| g.id == rock.id).unwrap();
        let jazz_row = genres.iter().find(|g| g.id == jazz.id).unwrap();
        assert_eq!(rock_row.track_count, 2, "two tracks carry Rock");
        assert_eq!(jazz_row.track_count, 0, "an unused genre stays at zero");
        assert_eq!(
            genres[0].id, jazz.id,
            "the list is ordered by the folded key, so Jazz precedes Rock",
        );
    }
}
