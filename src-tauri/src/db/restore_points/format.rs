/*
 * Restore point file format 1. A point is its own small SQLite file with no foreign keys: the
 * organization tables under their live names and columns, one identity row per track and cover they
 * reference, every root, and a one-row `meta`. The format is versioned apart from the schema, and a
 * reader checks `meta.format` before anything else, so that column stays in every later format.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::Connection;

// -- Local Imports --
use crate::normalize::normalize_path_key;
use crate::paths::relative_under;

/// The format this build writes, and the newest it reads.
pub const FORMAT_VERSION: i64 = 1;

/// The folder beside the database that holds the points.
pub const DIR_NAME: &str = "restore-points";

/// The name the point file is attached under while it is written.
pub(super) const SCHEMA: &str = "restore_point";

/// Why a point was taken. Each reason is its own retention ring, and the ring is read from the file
/// name, so an unreadable point still prunes with its ring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Reason {
    Version,
    Daily,
    Action,
    Restore,
}

impl Reason {
    pub const ALL: [Reason; 4] = [
        Reason::Version,
        Reason::Daily,
        Reason::Action,
        Reason::Restore,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Version => "version",
            Reason::Daily => "daily",
            Reason::Action => "action",
            Reason::Restore => "restore",
        }
    }

    pub fn parse(text: &str) -> Option<Reason> {
        Reason::ALL.into_iter().find(|r| r.as_str() == text)
    }
}

/// `rp-<created_at>-<reason>.sqlite`, `created_at` in unix ms.
pub(super) fn file_name(created_at: i64, reason: Reason) -> String {
    format!("rp-{created_at}-{}.sqlite", reason.as_str())
}

/// The sibling a point is built in before its rename.
pub(super) fn tmp_name(created_at: i64, reason: Reason) -> String {
    format!("rp-{created_at}-{}.tmp", reason.as_str())
}

/// The creation time and reason a finished point's file name carries, or None for any other name.
pub(super) fn parse_file_name(name: &str) -> Option<(i64, Reason)> {
    let stem = name.strip_prefix("rp-")?.strip_suffix(".sqlite")?;
    let (ms, reason) = stem.split_once('-')?;
    if ms.is_empty() || !ms.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((ms.parse().ok()?, Reason::parse(reason)?))
}

pub(super) fn is_tmp_name(name: &str) -> bool {
    name.starts_with("rp-") && name.ends_with(".tmp")
}

/// One captured table: copied whole, under the same name and columns in the point.
pub(super) struct DataTable {
    pub name: &'static str,
    pub columns: &'static [&'static str],
    /// The primary key, which orders the content hash.
    pub key: &'static str,
    /// The column naming a track, whose identity row the point then holds.
    pub track_column: Option<&'static str>,
    /// The column naming a cover, whose content hash the point then holds.
    pub cover_column: Option<&'static str>,
}

pub(super) const DATA_TABLES: &[DataTable] = &[
    DataTable {
        name: "albums",
        columns: &[
            "id",
            "title",
            "album_artist",
            "year",
            "genre",
            "cover_id",
            "created_at",
            "updated_at",
            "kind",
            "visualizer",
        ],
        key: "id",
        track_column: None,
        cover_column: Some("cover_id"),
    },
    DataTable {
        name: "album_tracks",
        columns: &["album_id", "track_id", "track_no", "keep_own_cover"],
        key: "album_id, track_id",
        track_column: Some("track_id"),
        cover_column: None,
    },
    DataTable {
        name: "playlists",
        columns: &[
            "id",
            "name",
            "created_at",
            "updated_at",
            "description",
            "cover_id",
        ],
        key: "id",
        track_column: None,
        cover_column: Some("cover_id"),
    },
    DataTable {
        name: "playlist_tracks",
        columns: &[
            "id",
            "playlist_id",
            "track_id",
            "album_id",
            "keep_order",
            "position",
        ],
        key: "id",
        track_column: Some("track_id"),
        cover_column: None,
    },
    DataTable {
        name: "track_edits",
        columns: &[
            "track_id",
            "title",
            "artist",
            "album",
            "album_artist",
            "year",
            "disc_no",
            "updated_at",
        ],
        key: "track_id",
        track_column: Some("track_id"),
        cover_column: None,
    },
    DataTable {
        name: "genres",
        columns: &["id", "name", "name_key", "created_at"],
        key: "id",
        track_column: None,
        cover_column: None,
    },
    DataTable {
        name: "track_genres",
        columns: &["track_id", "genre_id", "position"],
        key: "track_id, genre_id",
        track_column: Some("track_id"),
        cover_column: None,
    },
    DataTable {
        name: "track_covers",
        columns: &["track_id", "cover_id", "created_at"],
        key: "track_id",
        track_column: Some("track_id"),
        cover_column: Some("cover_id"),
    },
    DataTable {
        name: "track_visualizers",
        columns: &["track_id", "kind", "updated_at"],
        key: "track_id",
        track_column: Some("track_id"),
        cover_column: None,
    },
];

/// Live tables a point leaves out, with the reason. `tracks`, `roots` and `covers` appear in a point
/// only as identity rows.
#[cfg(test)]
pub(super) const EXCLUDED_TABLES: &[(&str, &str)] = &[
    ("tracks", "scan data; identity rows only"),
    ("roots", "identity rows only"),
    ("covers", "content manifest; identity rows only"),
    ("plays", "listening history, not organization"),
    ("settings", "preferences, not organization"),
    ("folder_covers", "bound to folders, not to the organization"),
    ("export_ledger", "describes files at a destination"),
    ("duplicate_dismissals", "scan-side review state"),
    ("scan_issues", "scan findings"),
    ("file_write_batches", "describes writes to files on disk"),
    ("file_write_journal", "crash recovery state for files on disk"),
    ("file_write_undo", "describes writes to files on disk"),
    ("meta", "legacy workspace row"),
];

/// Columns of a captured table a point leaves out, as (table, column, reason).
#[cfg(test)]
pub(super) const EXCLUDED_COLUMNS: &[(&str, &str, &str)] = &[];

// The point schema, created in the attached file before the copy. Column types and primary keys
// mirror the live tables, so a copied value keeps its stored type; the two composite keys are WITHOUT
// ROWID so their key is the table rather than a second copy beside it. A track identity row holds one
// path, read by `track_paths`.
pub(super) const SCHEMA_SQL: &str = "
CREATE TABLE restore_point.meta (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    format         INTEGER NOT NULL,
    app_version    TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    reason         TEXT NOT NULL,
    detail         TEXT,
    albums         INTEGER NOT NULL,
    singles        INTEGER NOT NULL,
    playlists      INTEGER NOT NULL,
    filed_tracks   INTEGER NOT NULL,
    edited_tracks  INTEGER NOT NULL,
    genre_tracks   INTEGER NOT NULL,
    content_hash   TEXT NOT NULL
);
CREATE TABLE restore_point.roots (
    id       INTEGER PRIMARY KEY,
    path     TEXT NOT NULL,
    root_key TEXT
);
CREATE TABLE restore_point.tracks (
    id            INTEGER PRIMARY KEY,
    root_id       INTEGER,
    rel_path      TEXT NOT NULL,
    path_key      TEXT,
    size_bytes    INTEGER NOT NULL,
    duration_secs REAL
);
CREATE TABLE restore_point.covers (
    id           INTEGER PRIMARY KEY,
    content_hash TEXT NOT NULL
);
CREATE TABLE restore_point.albums (
    id           INTEGER PRIMARY KEY,
    title        TEXT,
    album_artist TEXT,
    year         INTEGER,
    genre        TEXT,
    cover_id     INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    kind         TEXT NOT NULL,
    visualizer   TEXT
);
CREATE TABLE restore_point.album_tracks (
    album_id       INTEGER NOT NULL,
    track_id       INTEGER NOT NULL,
    track_no       INTEGER,
    keep_own_cover INTEGER NOT NULL,
    PRIMARY KEY (album_id, track_id)
) WITHOUT ROWID;
CREATE TABLE restore_point.playlists (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    description TEXT,
    cover_id    INTEGER
);
CREATE TABLE restore_point.playlist_tracks (
    id          INTEGER PRIMARY KEY,
    playlist_id INTEGER NOT NULL,
    track_id    INTEGER,
    album_id    INTEGER,
    keep_order  INTEGER NOT NULL,
    position    INTEGER NOT NULL
);
CREATE TABLE restore_point.track_edits (
    track_id     INTEGER PRIMARY KEY,
    title        TEXT,
    artist       TEXT,
    album        TEXT,
    album_artist TEXT,
    year         INTEGER,
    disc_no      INTEGER,
    updated_at   INTEGER NOT NULL
);
CREATE TABLE restore_point.genres (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE restore_point.track_genres (
    track_id INTEGER NOT NULL,
    genre_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (track_id, genre_id)
) WITHOUT ROWID;
CREATE TABLE restore_point.track_covers (
    track_id   INTEGER PRIMARY KEY,
    cover_id   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE restore_point.track_visualizers (
    track_id   INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
";

/// The one path a track identity row stores: its real-case path below its root, with `path_key` None,
/// when `track_paths` rebuilds exactly that real-case path and the stored key from it; otherwise its
/// whole real-case path with the stored key beside it. A row with no display path reads its key as
/// the real-case path. `root_path` is the track's root, None for a track without one.
pub(super) fn identity_path(
    root_path: Option<&str>,
    source_path: &str,
    display_path: Option<&str>,
) -> (String, Option<String>) {
    let display = display_path.unwrap_or(source_path);
    if let Some(root) = root_path {
        let rel = relative_under(Path::new(display), Path::new(root));
        if let Some(rel) = rel.as_deref().and_then(Path::to_str) {
            if track_paths(Some(root), rel, None) == (display.to_string(), source_path.to_string()) {
                return (rel.to_string(), None);
            }
        }
    }
    (display.to_string(), Some(source_path.to_string()))
}

/// A track identity row's (real-case path, folded key). With `path_key` None, `rel_path` is below
/// `root_path` and the key is rebuilt by the scan's own fold, as a walk of that root would key it.
pub(super) fn track_paths(
    root_path: Option<&str>,
    rel_path: &str,
    path_key: Option<&str>,
) -> (String, String) {
    match (path_key, root_path) {
        (Some(key), _) => (rel_path.to_string(), key.to_string()),
        (None, Some(root)) => {
            let full = if rel_path.is_empty() {
                PathBuf::from(root)
            } else {
                Path::new(root).join(rel_path)
            };
            let full = full.to_string_lossy().into_owned();
            let key = normalize_path_key(&full);
            (full, key)
        }
        (None, None) => (rel_path.to_string(), normalize_path_key(rel_path)),
    }
}

/// The blake3 hex of the data tables in `schema` (`main` or the attached point), read in key order
/// with every value tagged by its type. A library and a point taken from it hash the same, so a
/// caller can tell an unchanged library without writing anything.
pub(super) fn content_hash(conn: &Connection, schema: &str) -> rusqlite::Result<String> {
    let mut hasher = blake3::Hasher::new();
    for table in DATA_TABLES {
        hasher.update(&[0xfe]);
        feed_bytes(&mut hasher, table.name.as_bytes());
        let sql = format!(
            "SELECT {} FROM {schema}.{} ORDER BY {}",
            table.columns.join(", "),
            table.name,
            table.key
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            hasher.update(&[0xfd]);
            for i in 0..table.columns.len() {
                feed_value(&mut hasher, row.get_ref(i)?);
            }
        }
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn feed_value(hasher: &mut blake3::Hasher, value: ValueRef<'_>) {
    match value {
        ValueRef::Null => {
            hasher.update(&[0]);
        }
        ValueRef::Integer(i) => {
            hasher.update(&[1]);
            hasher.update(&i.to_le_bytes());
        }
        ValueRef::Real(f) => {
            hasher.update(&[2]);
            hasher.update(&f.to_bits().to_le_bytes());
        }
        ValueRef::Text(t) => {
            hasher.update(&[3]);
            feed_bytes(hasher, t);
        }
        ValueRef::Blob(b) => {
            hasher.update(&[4]);
            feed_bytes(hasher, b);
        }
    }
}

// Length first, so two adjacent values can never read as one.
fn feed_bytes(hasher: &mut blake3::Hasher, bytes: &[u8]) {
    hasher.update(&(bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}
