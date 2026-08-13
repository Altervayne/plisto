/*
 * The schema migration runner, keyed on PRAGMA user_version. Each step bumps the version once
 * its statements land, so migrate() is idempotent: an already-current DB runs nothing. Every
 * step is additive: columns and tables are added, nothing existing is dropped or rewritten, so
 * a running index survives an upgrade with its rows intact.
 */

// -- Library Imports --
use rusqlite::Connection;

// The latest schema version. user_version below this triggers the migrations up to it.
const LATEST_VERSION: i64 = 2;

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

/// Brings the connection's schema up to the latest version, running only the steps it still
/// needs. Safe to call on every open: a current DB does no work and returns Ok.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    while version < LATEST_VERSION {
        match version {
            0 => conn.execute_batch(MIGRATION_V1)?,
            1 => conn.execute_batch(MIGRATION_V2)?,
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

    /// A v1 DB with a row upgrades to v2 without losing data: the row survives and its new
    /// `has_embedded_cover` reads NULL, the drain sentinel.
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
        assert_eq!(version, 2);

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
}
