/*
 * The schema migration runner, keyed on PRAGMA user_version. Each step bumps the version once
 * its statements land, so migrate() is idempotent: an already-current DB runs nothing. Steps are
 * additive - columns and tables are added - save for the deliberate retirement of a dead column
 * once nothing reads it (v8) and the per-disc renumbering repair (v14), which both still preserve
 * every row. So a running index survives an upgrade with its rows intact.
 */

// -- Library Imports --
use rusqlite::Connection;

// The latest schema version. user_version below this triggers the migrations up to it.
const LATEST_VERSION: i64 = 16;

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

// Version 6: the library of roots. `roots` holds each scanned folder; `root_key` is the folded
// identity (UNIQUE, so a re-add is idempotent) and `path` the real-case walk anchor and display,
// mirroring the source_path/display_path split. `tracks.root_id` stamps each track's origin once
// at index time, CASCADE so removing a root drops its tracks; the index keeps the per-root
// presence sweep to one predicate. The one prior workspace seeds the first root (root_key left
// NULL for the ASCII-safe Rust-side fill on load), and every existing track backfills to it - the
// true prior state, since a single workspace held them all. A NULL workspace seeds no root, which
// is the fresh-install onboarding state.
const MIGRATION_V6: &str = "
CREATE TABLE roots (
    id       INTEGER PRIMARY KEY,
    root_key TEXT UNIQUE,
    path     TEXT NOT NULL,
    added_at INTEGER NOT NULL
);

ALTER TABLE tracks ADD COLUMN root_id INTEGER REFERENCES roots(id) ON DELETE CASCADE;

CREATE INDEX idx_tracks_root ON tracks(root_id);

INSERT INTO roots (path, added_at)
SELECT workspace_root, strftime('%s', 'now') FROM meta
WHERE id = 1 AND workspace_root IS NOT NULL;

UPDATE tracks SET root_id = (SELECT id FROM roots LIMIT 1);
";

// Version 7: the per-track edit layer and a managed genre vocabulary. All three tables are new and
// nothing existing is touched - `albums.genre` and the `album_tracks` overrides stay in place and
// keep serving the read path until a later step retires them. `track_edits` is 1:1 with `tracks`,
// keyed on track_id alone and independent of album membership, so a loose track can carry edits and
// an edit survives an album move; an ABSENT row means a pristine track that falls through to its raw
// scan values, and every value column is nullable so a present row still means "no edit" per unset
// field. `genres.name` is the real-case display form and `name_key` the folded identity and UNIQUE
// dedup key - left NULL-free but filled by the Rust-side seed, never SQL lower(), which is ASCII-only
// and would break fold-parity on accented names (the same reason root_key is filled on load).
// `track_genres.position` is the deterministic 1..N display and export order, mirroring
// album_tracks.track_no. All three CASCADE from tracks(id)/genres(id) so deleting a root, track, or
// genre cleans up with no orphans (PRAGMA foreign_keys is already ON). The in-migration backfill
// carries the real user overrides forward into track_edits so no edit is lost; it needs no
// case-folding, so it is safe in raw SQL. album_tracks.disc_no is deliberately NOT migrated: every
// stored value is the hard-coded default 1, never a user edit, and materializing it would pollute
// the "a track_edits row means a real edit" meaning - disc resolves from track_edits.disc_no ??
// raw_disc_no later, so existing members keep their raw disc through that fallback. The album-level
// `albums.genre` values are seeded into the vocabulary Rust-side on load, not here, because folding
// each to its identity key needs the real Unicode case-fold that SQL lower() cannot do.
const MIGRATION_V7: &str = "
CREATE TABLE track_edits (
    track_id     INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    title        TEXT,
    artist       TEXT,
    album        TEXT,
    album_artist TEXT,
    year         INTEGER,
    disc_no      INTEGER,
    updated_at   INTEGER NOT NULL
);

CREATE TABLE genres (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE track_genres (
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    genre_id  INTEGER NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    PRIMARY KEY (track_id, genre_id)
);

INSERT INTO track_edits (track_id, title, artist, updated_at)
SELECT track_id, title_override, artist_override, strftime('%s', 'now')
FROM album_tracks
WHERE title_override IS NOT NULL OR artist_override IS NOT NULL;
";

// Version 8: retires the now-dead album_tracks override columns. Since v7 all three have been written
// never and read never - the real title/artist overrides were backfilled into track_edits, and disc_no
// only ever held the hard-coded default 1 (disc resolves through track_edits.disc_no ?? raw_disc_no), so
// dropping them loses nothing. The membership row keeps album_id, track_id, and track_no. None of the
// three sit in the primary key, the UNIQUE, or any FK or index, so a plain DROP COLUMN is safe - the one
// deliberate exception to this file's otherwise additive history.
const MIGRATION_V8: &str = "
ALTER TABLE album_tracks DROP COLUMN title_override;
ALTER TABLE album_tracks DROP COLUMN artist_override;
ALTER TABLE album_tracks DROP COLUMN disc_no;
";

// Version 9: playlists, the one multi-membership container. A playlist is an ordered list of tracks
// where the SAME track may sit more than once, so a membership's identity is its slot - the
// `playlist_tracks.id` synthetic row - not its track_id. That is the deliberate break from albums and
// genres, which stay single-membership: there is no UNIQUE(track_id) and no UNIQUE(playlist_id,
// track_id) here, and `position` is a plain 1..N order that tolerates duplicates and gaps. Both
// foreign keys CASCADE, so deleting a playlist drops its slots and deleting a track (or its root)
// drops the slots that pointed at it while the playlist row stays. `name` is nullable like
// albums.title - NULL means unset, resolved to a display default in the frontend, never an empty
// string. The index keys the per-playlist ordered read to one predicate.
const MIGRATION_V9: &str = "
CREATE TABLE playlists (
    id         INTEGER PRIMARY KEY,
    name       TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE playlist_tracks (
    id          INTEGER PRIMARY KEY,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL
);

CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
";

// Version 10: playlist metadata. Two additive columns on `playlists`, both NULL for every existing
// row - the true prior state, since no playlist carried either before. `description` is free text,
// NULL meaning unset (resolved to a display default in the frontend, never an empty string).
// `cover_id` is the playlist's bound cover, reusing the content-hash `covers` manifest exactly as
// `albums.cover_id` does - a plain REFERENCES with no ON DELETE, matching the album binding, so the
// column carries the same shape the album cover already does. The ADD COLUMN keeps its implicit NULL
// default, which the REFERENCES clause requires. A playlist cover is only ever the one the user set:
// there is no member-track fallback the way an album's cover falls back to a member's art.
const MIGRATION_V10: &str = "
ALTER TABLE playlists ADD COLUMN description TEXT;
ALTER TABLE playlists ADD COLUMN cover_id INTEGER REFERENCES covers(id);
";

// Version 11: the per-membership keep-own-cover flag. One additive column on `album_tracks`, DEFAULT
// 0 for every existing row - the true prior state, since every member took the container cover before
// the flag existed. A 1 opts one membership out: the export embeds that track's own embedded or
// adjacent art instead of the album's, falling back to the container cover when the track has none.
// The ADD COLUMN backfills the whole table in place with no drain, the same shape albums.kind took.
const MIGRATION_V11: &str = "
ALTER TABLE album_tracks ADD COLUMN keep_own_cover INTEGER NOT NULL DEFAULT 0;
";

// Version 12: the per-track assigned cover. `track_covers` binds one imported cover to one track,
// keyed on the track alone (PRIMARY KEY) so a track carries at most one and a re-assign replaces it,
// mirroring `folder_covers`' one-choice-per-key shape. The `cover_id` reuses the content-hash
// `covers` manifest exactly as the folder, album and playlist bindings do. A new table only, so every
// existing row is untouched: a track with no assigned cover simply has no row and resolves through the
// folder/keep-own logic as before. The track FK CASCADEs so dropping a track (or its root) clears its
// binding; the cover FK is a plain REFERENCES, matching the other cover bindings.
const MIGRATION_V12: &str = "
CREATE TABLE track_covers (
    track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    cover_id   INTEGER NOT NULL REFERENCES covers(id),
    created_at INTEGER NOT NULL
);
";

// Version 13: the play-event log. `plays` is an append-only stream, one row per counted listen, never
// updated: `played_at` is the unix second the listen was recorded and `completed` splits a full play to
// the end (1) from one that only passed the halfway mark (0) - the weight the most-played score leans
// on. The track FK CASCADEs so dropping a track (or its root) clears its history, and the two plays
// indexes key the recently-played read (MAX played_at per track) and the windowed count. A new table
// only, so every existing row is untouched. `idx_track_genres_genre` rides along here: the
// `(track_id, genre_id)` primary key does not left-prefix `genre_id`, so a genre-first lookup had no
// index, and later genre filtering wants one.
const MIGRATION_V13: &str = "
CREATE TABLE plays (
    id        INTEGER PRIMARY KEY,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL,
    completed INTEGER NOT NULL
);
CREATE INDEX idx_plays_track     ON plays(track_id);
CREATE INDEX idx_plays_played_at ON plays(played_at);
CREATE INDEX idx_track_genres_genre ON track_genres(genre_id);
";

// Version 14: repairs membership numbering to per-disc positions. `track_no` is a track's position
// within its disc, but older rows can carry album-wide numbering, so a second disc may start at 4 or a
// disc may hold gaps. Each album's members renumber 1..k per resolved disc (the edit over the raw
// scan, unset reading as disc 1), in the order the album drawer lists them: disc, then track_no with a
// null first, then track id. The stored numbers then match what the drawer shows. Only
// `album_tracks.track_no` is written, and only where it differs, so a correct album is left alone and
// a re-run changes nothing.
const MIGRATION_V14: &str = "
WITH ranked AS (
    SELECT at.track_id,
           ROW_NUMBER() OVER (
               PARTITION BY at.album_id, COALESCE(te.disc_no, t.raw_disc_no, 1)
               ORDER BY COALESCE(at.track_no, 0), at.track_id
           ) AS position
    FROM album_tracks at
    JOIN tracks t ON t.id = at.track_id
    LEFT JOIN track_edits te ON te.track_id = at.track_id
)
UPDATE album_tracks
SET track_no = ranked.position
FROM ranked
WHERE ranked.track_id = album_tracks.track_id
  AND album_tracks.track_no IS NOT ranked.position;
";

// Version 15: the export record. `export_ledger` holds, per destination, the fingerprint of every file
// an export landed there, keyed on the folded destination and the file's path relative to it, so a
// changed-only export writes just the files whose fingerprint moved or that carry no row. No foreign
// key ties it to the library: a row describes a file sitting on the destination, which stays there
// whatever the library does. A new table only, so every existing row is untouched and the record
// starts empty.
const MIGRATION_V15: &str = "
CREATE TABLE export_ledger (
    dest_key    TEXT NOT NULL,
    rel_path    TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    exported_at INTEGER NOT NULL,
    PRIMARY KEY (dest_key, rel_path)
) WITHOUT ROWID;
";

// Version 16: dismissed duplicate pairs. `duplicate_dismissals` holds each pair of tracks the user said
// are not duplicates, stored once as (lower id, higher id) so a pair has a single row whichever way it
// was named; the CHECK rules out a reversed or self pair. Both track FKs CASCADE, so dropping either
// track drops its pairs, and the `track_hi` index covers the lookup the primary key does not
// left-prefix. A new table only, so every existing row is untouched and the set starts empty.
const MIGRATION_V16: &str = "
CREATE TABLE duplicate_dismissals (
    track_lo     INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    track_hi     INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (track_lo, track_hi),
    CHECK (track_lo < track_hi)
) WITHOUT ROWID;
CREATE INDEX idx_duplicate_dismissals_hi ON duplicate_dismissals(track_hi);
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
            5 => conn.execute_batch(MIGRATION_V6)?,
            6 => conn.execute_batch(MIGRATION_V7)?,
            7 => conn.execute_batch(MIGRATION_V8)?,
            8 => conn.execute_batch(MIGRATION_V9)?,
            9 => conn.execute_batch(MIGRATION_V10)?,
            10 => conn.execute_batch(MIGRATION_V11)?,
            11 => conn.execute_batch(MIGRATION_V12)?,
            12 => conn.execute_batch(MIGRATION_V13)?,
            13 => conn.execute_batch(MIGRATION_V14)?,
            14 => conn.execute_batch(MIGRATION_V15)?,
            15 => conn.execute_batch(MIGRATION_V16)?,
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
            .query_row("SELECT filename, has_embedded_cover FROM tracks", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
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
        assert_eq!(
            missing, None,
            "missing_at defaults to NULL, meaning present"
        );

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
        assert_eq!(
            display, None,
            "display_path is NULL until a scan captures it"
        );

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
        conn.execute_batch(
            "INSERT INTO albums (id, title, created_at, updated_at) VALUES (1, 'T', 0, 0);",
        )
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

    /// A v5 DB with a workspace and a track upgrades to v6 additively: the one workspace seeds a
    /// root (its `root_key` left NULL for the Rust-side fill), and the existing track backfills to
    /// that root's id, the true prior state of a single-workspace index.
    #[test]
    fn v5_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.pragma_update(None, "user_version", 5).unwrap();
        conn.execute_batch(
            "UPDATE meta SET workspace_root = '/music' WHERE id = 1;
             INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES ('/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let (root_id, path, key): (i64, String, Option<String>) = conn
            .query_row("SELECT id, path, root_key FROM roots", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(path, "/music", "the workspace seeds the first root");
        assert_eq!(
            key, None,
            "root_key is filled Rust-side, not in the migration"
        );

        let stamped: Option<i64> = conn
            .query_row("SELECT root_id FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            stamped,
            Some(root_id),
            "the existing track backfills to the seeded root"
        );
    }

    /// A v6 DB with an album_tracks override upgrades to v7 additively: the three per-track edit
    /// tables exist and the stored `title_override` is carried into `track_edits`.
    #[test]
    fn v6_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.execute_batch(MIGRATION_V6).unwrap();
        conn.pragma_update(None, "user_version", 6).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);
             INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO album_tracks (album_id, track_id, track_no, disc_no, title_override)
             VALUES (1, 1, 1, 1, 'Edited Title');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        for table in ["track_edits", "genres", "track_genres"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table} should exist after v7");
        }

        let title: Option<String> = conn
            .query_row(
                "SELECT title FROM track_edits WHERE track_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            title.as_deref(),
            Some("Edited Title"),
            "the stored override carried into track_edits"
        );
    }

    /// A v7 DB upgrades to v8 by dropping the dead album_tracks override columns: the membership row
    /// survives with its track_no, and title_override/artist_override/disc_no are gone from the table.
    #[test]
    fn v7_db_drops_dead_album_track_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.execute_batch(MIGRATION_V6).unwrap();
        conn.execute_batch(MIGRATION_V7).unwrap();
        conn.pragma_update(None, "user_version", 7).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);
             INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO album_tracks (album_id, track_id, track_no, disc_no, title_override)
             VALUES (1, 1, 5, 1, 'Stale Override');",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        // The membership row survives the drop; v14 then renumbers its lone disc from 1.
        let track_no: i64 = conn
            .query_row(
                "SELECT track_no FROM album_tracks WHERE track_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(track_no, 1, "the membership row survives, numbered on its disc");

        // The three retired columns are gone.
        for col in ["title_override", "artist_override", "disc_no"] {
            let present: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('album_tracks') WHERE name = ?1",
                    [col],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(present, 0, "column {col} should be dropped after v8");
        }
    }

    /// A v8 DB upgrades to v9 with the playlist tables: a track indexed at v8 survives, the same
    /// track sits in one playlist twice as two distinct slots (duplicates are intentional), deleting
    /// the track cascades its slots while the playlist stays, and deleting the playlist cascades the
    /// rest. The playlist rows are inserted after the migrate, since the tables do not exist at v8.
    #[test]
    fn v8_db_migrates_to_playlists_allowing_duplicate_slots() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.execute_batch(MIGRATION_V6).unwrap();
        conn.execute_batch(MIGRATION_V7).unwrap();
        conn.execute_batch(MIGRATION_V8).unwrap();
        conn.pragma_update(None, "user_version", 8).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        for table in ["playlists", "playlist_tracks"] {
            let found: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "table {table} should exist after v9");
        }

        // The same track sits in one playlist twice: two rows keyed on distinct slot ids.
        conn.execute_batch(
            "INSERT INTO playlists (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 1, 1);
             INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 1, 2);",
        )
        .unwrap();
        let slots: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = 1 AND track_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(slots, 2, "the same track sits twice as two distinct slots");

        // Deleting the track cascades its slots but leaves the playlist row.
        conn.execute("DELETE FROM tracks WHERE id = 1", []).unwrap();
        let after_track: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after_track, 0, "deleting a track cascades its slots");
        let playlists: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(playlists, 1, "the playlist row survives a track delete");

        // A fresh slot, then deleting the playlist cascades it away.
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (2, '/music/b.mp3', 'b.mp3', 'mp3', 10, 20, 30);
             INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 2, 1);",
        )
        .unwrap();
        conn.execute("DELETE FROM playlists WHERE id = 1", [])
            .unwrap();
        let after_playlist: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after_playlist, 0, "deleting a playlist cascades its slots");
    }

    /// A v9 DB with a playlist upgrades to v10 additively: the playlist row survives and its new
    /// `description` and `cover_id` both read NULL, unset until the user sets them.
    #[test]
    fn v9_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.execute_batch(MIGRATION_V6).unwrap();
        conn.execute_batch(MIGRATION_V7).unwrap();
        conn.execute_batch(MIGRATION_V8).unwrap();
        conn.execute_batch(MIGRATION_V9).unwrap();
        conn.pragma_update(None, "user_version", 9).unwrap();
        conn.execute_batch(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES (1, 'Mix', 0, 0);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let (name, description, cover): (String, Option<String>, Option<i64>) = conn
            .query_row(
                "SELECT name, description, cover_id FROM playlists",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(name, "Mix", "the existing playlist survives the upgrade");
        assert_eq!(description, None, "description defaults to NULL, unset");
        assert_eq!(cover, None, "cover_id defaults to NULL, unset");
    }

    /// A v10 DB with an album membership upgrades to v11 additively: the membership row survives and
    /// its new `keep_own_cover` backfills to 0, the container-cover default every member had before.
    #[test]
    fn v10_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.execute_batch(MIGRATION_V6).unwrap();
        conn.execute_batch(MIGRATION_V7).unwrap();
        conn.execute_batch(MIGRATION_V8).unwrap();
        conn.execute_batch(MIGRATION_V9).unwrap();
        conn.execute_batch(MIGRATION_V10).unwrap();
        conn.pragma_update(None, "user_version", 10).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);
             INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (1, 1, 1);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let (track_no, keep): (i64, i64) = conn
            .query_row(
                "SELECT track_no, keep_own_cover FROM album_tracks WHERE track_id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(track_no, 1, "the membership row survives the upgrade");
        assert_eq!(keep, 0, "keep_own_cover defaults to 0, the container cover");
    }

    /// A v11 DB with a track upgrades to v12 additively: the track row survives, the new
    /// `track_covers` table exists, and the track carries no binding until the user assigns one.
    #[test]
    fn v11_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.execute_batch(MIGRATION_V6).unwrap();
        conn.execute_batch(MIGRATION_V7).unwrap();
        conn.execute_batch(MIGRATION_V8).unwrap();
        conn.execute_batch(MIGRATION_V9).unwrap();
        conn.execute_batch(MIGRATION_V10).unwrap();
        conn.execute_batch(MIGRATION_V11).unwrap();
        conn.pragma_update(None, "user_version", 11).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let filename: String = conn
            .query_row("SELECT filename FROM tracks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(filename, "a.mp3", "the existing row survives the upgrade");

        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'track_covers'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "the track_covers table exists after v12");

        let bindings: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_covers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bindings, 0, "no track carries an assigned cover yet");
    }

    /// A v12 DB with a track upgrades to v13 additively: the track row survives, the new `plays` table
    /// exists, it starts empty, and a play cascades away with its track.
    #[test]
    fn v12_db_with_rows_migrates_additively() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.execute_batch(MIGRATION_V6).unwrap();
        conn.execute_batch(MIGRATION_V7).unwrap();
        conn.execute_batch(MIGRATION_V8).unwrap();
        conn.execute_batch(MIGRATION_V9).unwrap();
        conn.execute_batch(MIGRATION_V10).unwrap();
        conn.execute_batch(MIGRATION_V11).unwrap();
        conn.execute_batch(MIGRATION_V12).unwrap();
        conn.pragma_update(None, "user_version", 12).unwrap();
        conn.execute_batch(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (1, '/music/a.mp3', 'a.mp3', 'mp3', 10, 20, 30);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let filename: String = conn
            .query_row("SELECT filename FROM tracks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(filename, "a.mp3", "the existing row survives the upgrade");

        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'plays'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "the plays table exists after v13");

        let empty: i64 = conn
            .query_row("SELECT COUNT(*) FROM plays", [], |r| r.get(0))
            .unwrap();
        assert_eq!(empty, 0, "no play is recorded yet");

        // A recorded play cascades away when its track is deleted.
        conn.execute(
            "INSERT INTO plays (track_id, played_at, completed) VALUES (1, 100, 1)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM tracks WHERE id = 1", []).unwrap();
        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM plays", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 0, "deleting a track cascades its plays");
    }

    // A v13 DB, one step short of the per-disc renumbering repair.
    fn v13_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        for step in [
            MIGRATION_V1,
            MIGRATION_V2,
            MIGRATION_V3,
            MIGRATION_V4,
            MIGRATION_V5,
            MIGRATION_V6,
            MIGRATION_V7,
            MIGRATION_V8,
            MIGRATION_V9,
            MIGRATION_V10,
            MIGRATION_V11,
            MIGRATION_V12,
            MIGRATION_V13,
        ] {
            conn.execute_batch(step).unwrap();
        }
        conn.pragma_update(None, "user_version", 13).unwrap();
        conn
    }

    // Inserts a track with the given raw disc tag.
    fn insert_track(conn: &Connection, id: i64, disc: Option<i64>) {
        conn.execute(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at, raw_disc_no)
             VALUES (?1, '/music/' || ?1 || '.mp3', 'a.mp3', 'mp3', 10, 20, 30, ?2)",
            rusqlite::params![id, disc],
        )
        .unwrap();
    }

    // Every membership as (album_id, track_id, track_no), ordered for comparison.
    fn numbering(conn: &Connection) -> Vec<(i64, i64, Option<i64>)> {
        let mut stmt = conn
            .prepare(
                "SELECT album_id, track_id, track_no FROM album_tracks ORDER BY album_id, track_id",
            )
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    /// A v13 album numbered across its discs renumbers per disc: disc 1 keeps 1..3 and disc 2 restarts
    /// at 1. A disc edit wins over the raw tag, and no edit or album row is written.
    #[test]
    fn v13_renumbers_album_wide_numbering_per_disc() {
        let conn = v13_db();
        for (id, disc) in [(1, 1), (2, 1), (3, 1), (4, 2), (5, 1)] {
            insert_track(&conn, id, Some(disc));
        }
        conn.execute_batch(
            "INSERT INTO track_edits (track_id, disc_no, updated_at) VALUES (5, 2, 0);
             INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 7);
             INSERT INTO album_tracks (album_id, track_id, track_no)
             VALUES (1, 1, 1), (1, 2, 2), (1, 3, 3), (1, 4, 4), (1, 5, 5);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(
            numbering(&conn),
            vec![
                (1, 1, Some(1)),
                (1, 2, Some(2)),
                (1, 3, Some(3)),
                (1, 4, Some(1)),
                (1, 5, Some(2)),
            ],
        );
        let (edit_disc, edits): (i64, i64) = conn
            .query_row(
                "SELECT disc_no, (SELECT COUNT(*) FROM track_edits) FROM track_edits WHERE track_id = 5",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((edit_disc, edits), (2, 1), "the edit layer is untouched");
        let updated_at: i64 = conn
            .query_row("SELECT updated_at FROM albums WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(updated_at, 7, "the album row is untouched");
    }

    /// A null track_no numbers first on its disc, where the drawer lists it, and a gapped disc closes
    /// up to 1..k in its existing order.
    #[test]
    fn v13_numbers_a_null_first_and_closes_gaps() {
        let conn = v13_db();
        for id in 1..=6 {
            insert_track(&conn, id, None);
        }
        conn.execute_batch(
            "INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0), (2, 0, 0);
             INSERT INTO album_tracks (album_id, track_id, track_no)
             VALUES (1, 1, 1), (1, 2, NULL), (1, 3, 2),
                    (2, 4, 7), (2, 5, 1), (2, 6, 3);",
        )
        .unwrap();

        migrate(&conn).unwrap();

        assert_eq!(
            numbering(&conn),
            vec![
                (1, 1, Some(2)),
                (1, 2, Some(1)),
                (1, 3, Some(3)),
                (2, 4, Some(3)),
                (2, 5, Some(1)),
                (2, 6, Some(2)),
            ],
        );
    }

    /// An album already numbered per disc and a single keep their rows, and re-running the repair
    /// changes nothing.
    #[test]
    fn v13_leaves_correct_numbering_alone_and_is_idempotent() {
        let conn = v13_db();
        for (id, disc) in [(1, Some(1)), (2, Some(1)), (3, Some(2)), (4, None)] {
            insert_track(&conn, id, disc);
        }
        conn.execute_batch(
            "INSERT INTO albums (id, kind, created_at, updated_at)
             VALUES (1, 'album', 0, 0), (2, 'single', 0, 0);
             INSERT INTO album_tracks (album_id, track_id, track_no)
             VALUES (1, 1, 1), (1, 2, 2), (1, 3, 1), (2, 4, 1);",
        )
        .unwrap();
        let before = numbering(&conn);

        migrate(&conn).unwrap();
        assert_eq!(numbering(&conn), before);

        conn.execute_batch(MIGRATION_V14).unwrap();
        assert_eq!(numbering(&conn), before);
    }

    /// A v14 DB with rows upgrades to v15 additively: every existing row survives and the new
    /// `export_ledger` table exists empty.
    #[test]
    fn v14_db_with_rows_migrates_additively() {
        let conn = v13_db();
        conn.execute_batch(MIGRATION_V14).unwrap();
        conn.pragma_update(None, "user_version", 14).unwrap();
        insert_track(&conn, 1, Some(1));
        insert_track(&conn, 2, None);
        conn.execute_batch(
            "INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (1, 1, 1), (1, 2, 2);
             INSERT INTO plays (track_id, played_at, completed) VALUES (1, 100, 1);",
        )
        .unwrap();
        let before = numbering(&conn);

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);

        let counts: (i64, i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM tracks), (SELECT COUNT(*) FROM albums),
                        (SELECT COUNT(*) FROM plays)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (2, 1, 1), "every existing row survives the upgrade");
        assert_eq!(numbering(&conn), before, "the membership is untouched");

        let ledger: i64 = conn
            .query_row("SELECT COUNT(*) FROM export_ledger", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ledger, 0, "the export record starts empty");
    }

    /// A v15 DB with rows upgrades to v16 additively: every existing row survives and the new
    /// `duplicate_dismissals` table exists empty.
    #[test]
    fn v15_db_with_rows_migrates_additively() {
        let conn = v13_db();
        conn.execute_batch(MIGRATION_V14).unwrap();
        conn.execute_batch(MIGRATION_V15).unwrap();
        conn.pragma_update(None, "user_version", 15).unwrap();
        insert_track(&conn, 1, Some(1));
        insert_track(&conn, 2, None);
        conn.execute_batch(
            "INSERT INTO albums (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO album_tracks (album_id, track_id, track_no) VALUES (1, 1, 1), (1, 2, 2);
             INSERT INTO plays (track_id, played_at, completed) VALUES (1, 100, 1);
             INSERT INTO playlists (id, created_at, updated_at) VALUES (1, 0, 0);
             INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 2, 1);
             INSERT INTO export_ledger (dest_key, rel_path, fingerprint, exported_at)
                 VALUES ('d', 'a.mp3', 'f', 1);",
        )
        .unwrap();
        let before = numbering(&conn);

        migrate(&conn).unwrap();

        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, LATEST_VERSION);
        assert_eq!(version, 16);

        let counts: (i64, i64, i64, i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM tracks), (SELECT COUNT(*) FROM albums),
                        (SELECT COUNT(*) FROM plays), (SELECT COUNT(*) FROM playlist_tracks),
                        (SELECT COUNT(*) FROM export_ledger)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            counts,
            (2, 1, 1, 1, 1),
            "every existing row survives the upgrade"
        );
        assert_eq!(numbering(&conn), before, "the membership is untouched");

        let dismissals: i64 = conn
            .query_row("SELECT COUNT(*) FROM duplicate_dismissals", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(dismissals, 0, "the dismissal set starts empty");

        let reversed = conn.execute(
            "INSERT INTO duplicate_dismissals (track_lo, track_hi, dismissed_at) VALUES (2, 1, 0)",
            [],
        );
        assert!(reversed.is_err(), "a reversed pair is rejected");
    }

    /// A fresh v5 DB with no workspace seeds no root on the v6 upgrade: the onboarding state.
    #[test]
    fn v6_seeds_no_root_without_a_workspace() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.execute_batch(MIGRATION_V2).unwrap();
        conn.execute_batch(MIGRATION_V3).unwrap();
        conn.execute_batch(MIGRATION_V4).unwrap();
        conn.execute_batch(MIGRATION_V5).unwrap();
        conn.pragma_update(None, "user_version", 5).unwrap();

        migrate(&conn).unwrap();

        let roots: i64 = conn
            .query_row("SELECT COUNT(*) FROM roots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(roots, 0, "a NULL workspace seeds no root");
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
