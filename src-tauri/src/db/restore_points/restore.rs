/*
 * Restoring a point: the library's organization is replaced by the point's, never merged. The point is
 * read and checked whole into memory first, with no library lock needed, and every apply rebuilds its
 * plan inside its own write transaction rather than trusting an earlier dry run. Before the write, a
 * point of the library as it is goes into the restore ring; that point is the undo, and when it cannot
 * be saved nothing is written. The point being restored is in memory by then, so the ring's prune may
 * remove it.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection, Transaction, TransactionBehavior};

// -- Local Imports --
use super::collapse::{rebuild, Rebuilt};
use super::format::{DataTable, Reason};
use super::load::{load, PointData};
use super::matching::{match_tracks, LiveRoot, LiveTrack};
use super::take::{take, PointError, Taken};
use crate::db::{folder_moves, root_moves};
use crate::dto::RestoreSummary;

/// Why a restore did not happen. Every variant leaves the library as it was.
#[derive(Debug)]
pub enum RestoreError {
    /// Written by a later format.
    Newer { format: i64 },
    /// The file is missing, cut short, or does not open as a point.
    Unreadable(String),
    /// The file opens, but its rows disagree with its own record.
    Integrity(String),
    /// The point of the library as it is could not be saved.
    BeforePoint(String),
    Failed(String),
}

impl RestoreError {
    /// The refusal's name in boot.log; None for a failure.
    pub fn refusal(&self) -> Option<&'static str> {
        match self {
            RestoreError::Newer { .. } => Some("newer"),
            RestoreError::Unreadable(_) => Some("unreadable"),
            RestoreError::Integrity(_) => Some("integrity"),
            RestoreError::BeforePoint(_) => Some("before_point"),
            RestoreError::Failed(_) => None,
        }
    }
}

impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RestoreError::Newer { format } => {
                write!(f, "the restore point was written by a newer version (format {format})")
            }
            RestoreError::Unreadable(e)
            | RestoreError::Integrity(e)
            | RestoreError::BeforePoint(e)
            | RestoreError::Failed(e) => write!(f, "{e}"),
        }
    }
}

impl From<rusqlite::Error> for RestoreError {
    fn from(e: rusqlite::Error) -> Self {
        RestoreError::Failed(e.to_string())
    }
}

/// A written restore.
#[derive(Debug)]
pub struct Applied {
    pub summary: RestoreSummary,
    /// The point saved just before the write; None when the library held nothing to save.
    pub before: Option<Taken>,
}

/// A point read and checked into memory, ready to plan or apply. Reading needs no library lock, and
/// the file may go once this is loaded.
pub struct LoadedPoint {
    data: PointData,
    file: Option<String>,
}

/// Reads and checks the point at `point`. Refused when it is newer, unreadable or inconsistent.
pub fn load_point(point: &Path) -> Result<LoadedPoint, RestoreError> {
    Ok(LoadedPoint {
        data: load(point)?,
        file: point.file_name().and_then(|n| n.to_str()).map(str::to_string),
    })
}

/// What restoring `point` would do to the library on `conn`. Writes nothing.
pub fn plan_restore(conn: &Connection, point: &LoadedPoint) -> Result<RestoreSummary, RestoreError> {
    let tx = Transaction::new_unchecked(conn, TransactionBehavior::Deferred)?;
    let summary = plan(&tx, &point.data)?.summary;
    tx.rollback()?;
    Ok(summary)
}

/// Replaces the organization on `conn` with `point`. A point of the library as it is is saved into
/// `dir` first, and `saved` hears how that went before anything is written; when it fails, the
/// restore is refused. `conn` must have no open transaction.
pub fn apply_restore(
    conn: &mut Connection,
    point: &LoadedPoint,
    dir: &Path,
    now_ms: i64,
    saved: impl FnOnce(&Result<Option<Taken>, PointError>),
) -> Result<Applied, RestoreError> {
    let taken = take(conn, dir, Reason::Restore, point.file.as_deref(), now_ms);
    saved(&taken);
    let before = taken.map_err(|e| RestoreError::BeforePoint(e.error))?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Rebuilt { tables, summary } = plan(&tx, &point.data)?;
    write(&tx, &tables)?;
    check_foreign_keys(&tx, &tables)?;
    tx.commit()?;
    Ok(Applied { summary, before })
}

// Matches the point against the library and rebuilds its rows.
fn plan(conn: &Connection, data: &PointData) -> rusqlite::Result<Rebuilt> {
    let live_roots: Vec<LiveRoot> = conn
        .prepare("SELECT id, path FROM roots")?
        .query_map([], |r| {
            Ok(LiveRoot {
                id: r.get(0)?,
                path: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let live_tracks: Vec<LiveTrack> = conn
        .prepare("SELECT id, root_id, source_path FROM tracks")?
        .query_map([], |r| {
            Ok(LiveTrack {
                id: r.get(0)?,
                root_id: r.get(1)?,
                key: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let live_covers: HashMap<String, i64> = conn
        .prepare("SELECT content_hash, id FROM covers")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let moves = root_moves(conn)?;
    let located = folder_moves(conn)?;

    let map = match_tracks(&data.roots, &data.tracks, &live_roots, &live_tracks, &moves, &located);
    let mut rebuilt = rebuild(data, &map, &live_covers);

    // Tracks the point holds nothing for lose their per-track rows to the replace.
    let carrying: HashSet<i64> = conn
        .prepare(
            "SELECT track_id FROM track_edits UNION SELECT track_id FROM track_genres
             UNION SELECT track_id FROM track_covers UNION SELECT track_id FROM track_visualizers",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let restored: HashSet<i64> = map.matched.values().copied().collect();
    rebuilt.summary.cleared_tracks = carrying.difference(&restored).count() as i64;
    Ok(rebuilt)
}

// Empties the captured tables, dependents first so no delete cascades, then inserts the rebuilt rows
// parents first.
fn write(conn: &Connection, tables: &[(&DataTable, Vec<Vec<Value>>)]) -> rusqlite::Result<()> {
    for (table, _) in tables.iter().rev() {
        conn.execute(&format!("DELETE FROM {}", table.name), [])?;
    }
    for (table, rows) in tables {
        let marks: Vec<String> = (1..=table.columns.len()).map(|i| format!("?{i}")).collect();
        let mut insert = conn.prepare(&format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table.name,
            table.columns.join(", "),
            marks.join(", ")
        ))?;
        for row in rows {
            insert.execute(params_from_iter(row))?;
        }
    }
    Ok(())
}

fn check_foreign_keys(
    conn: &Connection,
    tables: &[(&DataTable, Vec<Vec<Value>>)],
) -> Result<(), RestoreError> {
    for (table, _) in tables {
        let mut stmt = conn.prepare(&format!("PRAGMA foreign_key_check({})", table.name))?;
        if stmt.query([])?.next()?.is_some() {
            return Err(RestoreError::Failed(format!(
                "a restored {} row names a missing row",
                table.name
            )));
        }
    }
    Ok(())
}
