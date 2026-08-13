/*
 * The schema migration runner, keyed on PRAGMA user_version. Each step bumps the version once
 * its statements land, so migrate() is idempotent: an already-current DB runs nothing. There
 * is only version 1 today; version 2 slots in as another arm when the first ALTER arrives.
 */

// -- Library Imports --
use rusqlite::Connection;

// The latest schema version. user_version below this triggers the migrations up to it.
const LATEST_VERSION: i64 = 1;

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

/// Brings the connection's schema up to the latest version, running only the steps it still
/// needs. Safe to call on every open: a current DB does no work and returns Ok.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    while version < LATEST_VERSION {
        match version {
            0 => conn.execute_batch(MIGRATION_V1)?,
            _ => unreachable!("no migration defined for user_version {version}"),
        }
        version += 1;
        conn.pragma_update(None, "user_version", version)?;
    }

    Ok(())
}
