/*
 * Reading a point back for a restore. The file is opened read-only on a connection of its own and
 * checked before any row is used: its length against its header, `integrity_check`, the format, then
 * the meta counts and content hash against the rows it holds. Every row is read into memory, so the
 * file may be pruned while the restore that read it is still writing.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags};

// -- Local Imports --
use super::format::{content_hash, track_paths, DataTable, DATA_TABLES, FORMAT_VERSION};
use super::list::{check_length, meta_row, PointMeta};
use super::restore::RestoreError;
use crate::db::{ALBUM_KIND, SINGLE_KIND};

/// A root as the point recorded it.
pub(super) struct PointRoot {
    pub id: i64,
    pub path: String,
}

/// A track identity row with its paths rebuilt: real-case `display` and folded `key`.
pub(super) struct PointTrack {
    pub id: i64,
    pub root_id: Option<i64>,
    pub display: String,
    pub key: String,
}

/// One captured table's rows in key order, each value in its table's column order.
pub(super) struct Rows {
    pub table: &'static DataTable,
    pub rows: Vec<Vec<Value>>,
}

impl Rows {
    /// The index of `column` in each row.
    pub fn col(&self, column: &str) -> usize {
        column_index(self.table, column)
    }
}

/// The position of `column` in `table`'s captured columns. The lists are fixed, so a missing name
/// is a programming error.
pub(super) fn column_index(table: &DataTable, column: &str) -> usize {
    table
        .columns
        .iter()
        .position(|c| *c == column)
        .unwrap_or_else(|| panic!("{}.{column} is a captured column", table.name))
}

/// A whole point, read and checked.
pub(super) struct PointData {
    pub meta: PointMeta,
    pub roots: Vec<PointRoot>,
    pub tracks: Vec<PointTrack>,
    /// Cover id to content hash.
    pub covers: HashMap<i64, String>,
    /// One per captured table, in `DATA_TABLES` order.
    pub tables: Vec<Rows>,
}

impl PointData {
    pub fn table(&self, name: &str) -> &Rows {
        self.tables
            .iter()
            .find(|t| t.table.name == name)
            .unwrap_or_else(|| panic!("{name} is a captured table"))
    }
}

/// Reads and checks the point at `path`. A file that does not open as a point is unreadable; one that
/// opens but whose rows disagree with its own record fails integrity.
pub(super) fn load(path: &Path) -> Result<PointData, RestoreError> {
    let bytes = std::fs::metadata(path)
        .map_err(|e| RestoreError::Unreadable(e.to_string()))?
        .len();
    check_length(path, bytes).map_err(RestoreError::Unreadable)?;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(unreadable)?;
    check_integrity(&conn)?;

    let format: i64 = conn
        .query_row("SELECT format FROM meta WHERE id = 1", [], |r| r.get(0))
        .map_err(unreadable)?;
    if format > FORMAT_VERSION {
        return Err(RestoreError::Newer { format });
    }
    if format < 1 {
        return Err(RestoreError::Unreadable(format!("unknown format {format}")));
    }
    let meta = meta_row(&conn).map_err(unreadable)?;

    let data = read(&conn, meta).map_err(unreadable)?;
    check_counts(&data)?;
    check_identities(&data)?;
    let hash = content_hash(&conn, "main").map_err(unreadable)?;
    if hash != data.meta.content_hash {
        return Err(RestoreError::Integrity(
            "the rows do not match the recorded content hash".to_string(),
        ));
    }
    Ok(data)
}

fn unreadable(e: rusqlite::Error) -> RestoreError {
    RestoreError::Unreadable(e.to_string())
}

fn check_integrity(conn: &Connection) -> Result<(), RestoreError> {
    let mut stmt = conn
        .prepare("PRAGMA integrity_check")
        .map_err(unreadable)?;
    let found = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(unreadable)?;
    if found != ["ok"] {
        return Err(RestoreError::Integrity(found.join("; ")));
    }
    Ok(())
}

fn read(conn: &Connection, meta: PointMeta) -> rusqlite::Result<PointData> {
    let roots: Vec<PointRoot> = conn
        .prepare("SELECT id, path FROM roots ORDER BY id")?
        .query_map([], |r| {
            Ok(PointRoot {
                id: r.get(0)?,
                path: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let root_paths: HashMap<i64, &str> = roots.iter().map(|r| (r.id, r.path.as_str())).collect();

    let mut stmt = conn.prepare("SELECT id, root_id, rel_path, path_key FROM tracks ORDER BY id")?;
    let mut rows = stmt.query([])?;
    let mut tracks = Vec::new();
    while let Some(row) = rows.next()? {
        let root_id: Option<i64> = row.get(1)?;
        let rel_path: String = row.get(2)?;
        let path_key: Option<String> = row.get(3)?;
        let root_path = root_id.and_then(|id| root_paths.get(&id).copied());
        let (display, key) = track_paths(root_path, &rel_path, path_key.as_deref());
        tracks.push(PointTrack {
            id: row.get(0)?,
            root_id,
            display,
            key,
        });
    }

    let covers: HashMap<i64, String> = conn
        .prepare("SELECT id, content_hash FROM covers")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let mut tables = Vec::with_capacity(DATA_TABLES.len());
    for table in DATA_TABLES {
        let sql = format!(
            "SELECT {} FROM {} ORDER BY {}",
            table.columns.join(", "),
            table.name,
            table.key
        );
        let mut stmt = conn.prepare(&sql)?;
        let width = table.columns.len();
        let rows = stmt
            .query_map([], |r| (0..width).map(|i| r.get::<_, Value>(i)).collect())?
            .collect::<rusqlite::Result<Vec<Vec<Value>>>>()?;
        tables.push(Rows { table, rows });
    }

    Ok(PointData {
        meta,
        roots,
        tracks,
        covers,
        tables,
    })
}

/// The integer in `value`, None for NULL or any other type.
pub(super) fn int(value: &Value) -> Option<i64> {
    match value {
        Value::Integer(i) => Some(*i),
        _ => None,
    }
}

fn check_counts(data: &PointData) -> Result<(), RestoreError> {
    let albums = data.table("albums");
    let kind = albums.col("kind");
    let of_kind = |k: &str| {
        albums
            .rows
            .iter()
            .filter(|r| matches!(&r[kind], Value::Text(t) if t == k))
            .count() as i64
    };
    let track_genres = data.table("track_genres");
    let genre_track = track_genres.col("track_id");
    let genre_tracks = track_genres
        .rows
        .iter()
        .filter_map(|r| int(&r[genre_track]))
        .collect::<HashSet<_>>()
        .len() as i64;
    let found = [
        of_kind(ALBUM_KIND),
        of_kind(SINGLE_KIND),
        data.table("playlists").rows.len() as i64,
        data.table("album_tracks").rows.len() as i64,
        data.table("track_edits").rows.len() as i64,
        genre_tracks,
    ];
    let m = &data.meta;
    let recorded = [
        m.albums,
        m.singles,
        m.playlists,
        m.filed_tracks,
        m.edited_tracks,
        m.genre_tracks,
    ];
    if found != recorded {
        return Err(RestoreError::Integrity(format!(
            "the rows count {found:?}, the point records {recorded:?}"
        )));
    }
    Ok(())
}

// Every track a captured row names has its identity row, or its paths could not be matched.
fn check_identities(data: &PointData) -> Result<(), RestoreError> {
    let known: HashSet<i64> = data.tracks.iter().map(|t| t.id).collect();
    for rows in &data.tables {
        let Some(column) = rows.table.track_column else {
            continue;
        };
        let at = rows.col(column);
        if let Some(id) = rows
            .rows
            .iter()
            .filter_map(|r| int(&r[at]))
            .find(|id| !known.contains(id))
        {
            return Err(RestoreError::Integrity(format!(
                "track {id} in {} has no identity row",
                rows.table.name
            )));
        }
    }
    Ok(())
}
