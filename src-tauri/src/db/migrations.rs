/*
 * The schema migration runner, keyed on PRAGMA user_version. Each step bumps the version once
 * its statements land, so migrate() is idempotent: an already-current DB runs nothing. Every
 * step is additive: columns and tables are added, nothing existing is dropped or rewritten, so
 * a running index survives an upgrade with its rows intact.
 */

// -- Library Imports --
use rusqlite::Connection;

// The latest schema version. user_version below this triggers the migrations up to it.
const LATEST_VERSION: i64 = 5;

// Version 1: the sole `tracks` table plus a single-row `meta` holding the active workspace.
// No tag-column indexes; UNIQUE(source_path) is the only one and doubles as the upsert key.
const MIGRATION_V1: &str = "
CREATE TABLE tracks (
    id               INTEGER PRIMARY KEY,
    source_path      TEXT NOT NULL UNIQUE,
    filename         TEXT NOT NULL,
    ext              TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    mtime            INTEGER NOT NULL,
    duration_secs    REAL,
    raw_title        TEXT,
    raw_artist       TEXT,
    raw_album        TEXT,
    raw_album_artist TEXT,
    raw_track_no     INTEGER,
    raw_disc_no      INTEGER,
    raw_year         INTEGER,
    raw_genre        TEXT,
    scanned_at       INTEGER NOT NULL
);

CREATE TABLE meta (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    workspace_root TEXT
);

INSERT INTO meta (id, workspace_root) VALUES (1, NULL);
";

// Version 2: album art. `has_embedded_cover` is tri-state and deliberately has no default -
// NULL marks a row the scan has not yet examined for art, and the widened re-read drains it to
// 0/1. `covers` is the content-addressed manifest keyed on the blake3 hash of the raw art
// bytes; thumbnail files derive from that hash, so no path column is kept. `folder_covers`
// holds the user's per-folder choice, written only on an explicit import.
const MIGRATION_V2: &str = "
ALTER TABLE tracks ADD COLUMN has_embedded_cover INTEGER;

CREATE TABLE covers (
    id           INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL UNIQUE,
    source_kind  TEXT NOT NULL,
    origin_path  TEXT,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    byte_len     INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE TABLE folder_covers (
    folder_path TEXT PRIMARY KEY,
    cover_id    INTEGER NOT NULL REFERENCES covers(id),
    set_at      INTEGER NOT NULL
);
";

// Version 3: albums and single-membership assignment. `missing_at` on tracks is NULL for a
// present file and a timestamp for a file gone since that scan; the ADD COLUMN NULL default is
// the true state of every existing row, so no drain is needed. `albums` metadata is all
// nullable (NULL = unset, resolved to a display default, never an empty string), with the cover
// reusing the content-hash `covers` manifest. `album_tracks` carries the per-track ordering and
// non-destructive overrides; UNIQUE(track_id) enforces that a track belongs to at most one
// album, and both foreign keys CASCADE so deleting an album drops its membership, not the tracks.
const MIGRATION_V3: &str = "
ALTER TABLE tracks ADD COLUMN missing_at INTEGER;

CREATE TABLE albums (
    id           INTEGER PRIMARY KEY,
    title        TEXT,
    album_artist TEXT,
    year         INTEGER,
    genre        TEXT,
    cover_id     INTEGER REFERENCES covers(id),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE album_tracks (
    album_id        INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    track_id        INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    track_no        INTEGER,
    disc_no         INTEGER,
    title_override  TEXT,
    artist_override TEXT,
    PRIMARY KEY (album_id, track_id),
    UNIQUE (track_id)
);
";

// Version 4: real-case display path and a key-value settings store. `source_path` is the
// case-folded dedup key and loses the path's real casing; `display_path` keeps it so folder
// names and full paths render correctly while identity stays on the folded key. It is NULL
// until a scan captures it, and the next scan drains legacy rows from the walk's real path -
// no tag re-read. `settings` is a small kv store for client prefs, so every future pref is a
// new key rather than a new migration.
const MIGRATION_V4: &str = "
ALTER TABLE tracks ADD COLUMN display_path TEXT;

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

// Version 5: the album `kind`. A Single is an album-of-one with kind='single', a plain album is
// kind='album'; the two share every album column, override, and cover binding. DEFAULT 'album' is
// the true state of every existing row - each was a plain album before singles existed - so the
// ADD COLUMN backfills the whole table in place with no drain.
const MIGRATION_V5: &str = "
ALTER TABLE albums ADD COLUMN kind TEXT NOT NULL DEFAULT 'album';
";

/// Brings the connection's schema up to the latest version, running only the steps it still
/// needs. Safe to call on every open: a current DB does no work and returns Ok.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    while version < LATEST_VERSION {
        match version {
            0 => conn.execute_batch(MIGRATION_V1)?,
            1 => conn.execute_batch(MIGRATION_V2)?,
            2 => conn.execute_batch(MIGRATION_V3)?,
            3 => conn.execute_batch(MIGRATION_V4)?,
            4 => conn.execute_batch(MIGRATION_V5)?,
            _ => unreachable!("no migration defined for user_version {version}"),
        }
        version += 1;
        conn.pragma_update(None, "user_version", version)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A v1 DB with a row upgrades to the latest version without losing data: the row survives
    /// and its new `has_embedded_cover` reads NULL, the drain sentinel.
    #[test]
    fn v1_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES ('/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let (filename, art): (String, Option<i64>) = conn
            .query_row(
                "SELECT filename, has_embedded_cover FROM tracks",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(filename, "a.mp3", "the existing row survives the upgrade");
        assert_eq!(art, None, "the new column is NULL, the drain sentinel");
    }

    /// A v2 DB with a row upgrades to v3 additively: the row survives and its new `missing_at`
    /// reads NULL, which already means present.
    #[test]
    fn v2_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.pragma_update(None, "user_version", 2).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES ('/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let (filename, missing): (String, Option<i64>) = conn
            .query_row("SELECT filename, missing_at FROM tracks", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(filename, "a.mp3", "the existing row survives the upgrade");
        assert_eq!(missing, None, "missing_at defaults to NULL, meaning present");

        for table in ["albums", "album_tracks"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table} should exist after v3");
        }
    }

    /// A v3 DB with a row upgrades to v4 additively: the row survives and its new `display_path`
    /// reads NULL until a scan captures it, and the empty `settings` store is created.
    #[test]
    fn v3_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.pragma_update(None, "user_version", 3).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES ('/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let (filename, display): (String, Option<String>) = conn
            .query_row("SELECT filename, display_path FROM tracks", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(filename, "a.mp3", "the existing row survives the upgrade");
        assert_eq!(display, None, "display_path is NULL until a scan captures it");

        let settings: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(settings, 1, "the settings store exists after v4");
    }

    /// A v4 DB with an album upgrades to v5 additively: the album row survives and its new `kind`
    /// backfills to 'album', since every pre-single album is a plain album.
    #[test]
    fn v4_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.pragma_update(None, "user_version", 4).unwrap();
        conn.execute_batch("INSERT INTO albums (id, title, created_at, updated_at) VALUES (1, 'T', 0, 0);")
            .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let (title, kind): (String, String) = conn
            .query_row("SELECT title, kind FROM albums", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title, "T", "the existing album survives the upgrade");
        assert_eq!(kind, "album", "the new column backfills to 'album'");
    }

    /// `album_tracks.UNIQUE(track_id)` enforces single membership: a second album cannot claim a
    /// track already assigned to one.
    #[test]
    fn album_tracks_rejects_a_second_membership() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);
             INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0), (2, 0, 0);
             INSERT INTO album_tracks (album_id, track_id) VALUES (1, 1);",
        )
        .unwrap();

        let second = conn.execute(
            "INSERT INTO album_tracks (album_id, track_id) VALUES (2, 1)",
            [],
        );
        assert!(second.is_err(), "a track cannot join a second album");
    }

    /// Deleting an album cascades to its membership only: the assigned track's own row stays.
    #[test]
    fn deleting_an_album_cascades_membership_not_tracks() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);
             INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO album_tracks (album_id, track_id) VALUES (1, 1);",
        )
        .unwrap();

        conn.execute("DELETE FROM albums WHERE id = 1", []).unwrap();

        let memberships: i64 = conn
            .query_row("SELECT COUNT(*) FROM album_tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(memberships, 0, "the membership is cascaded away");
        let tracks: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tracks, 1, "the track row itself survives");
    }
}
