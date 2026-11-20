/*
 * The persistence layer for writes to the user's music files: batches, the crash journal and the
 * undo rows. A journal row exists only while one file is in flight; `finish_file` retires it and
 * records the undo row in one transaction, so a crash leaves either the journal row (recovery
 * rolls the file back) or the finished state, never half of each. A file Plisto must delete after
 * a write commits is listed in its undo row's `sweep_json` first, so a failed delete is retried
 * by a later sweep instead of being orphaned. Stamp undo rows live until the next stamp batch
 * writes its first file; a superseded row that still lists files loses its undo data and stays
 * until the sweep empties its list.
 */

// -- Library Imports --
use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

// -- Type Imports --
use crate::normalize::normalize_path_key;

pub const DAY_SECS: i64 = 86_400;

/// A file to delete after a committed write: its name beside the source, and the size it must
/// still have for the delete to be safe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SweepEntry {
    pub name: String,
    pub size: i64,
}

/// One write batch: a stamp run with its retries, or a single trim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRow {
    pub id: i64,
    pub kind: String,
    /// The scope label shown on the Settings last-write line.
    pub label: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub files_written: i64,
    pub undone_at: Option<i64>,
}

/// A file in flight. `rel_key` is derived from `rel_path` on insert and is what `UNIQUE
/// (root_id, rel_key)` holds, so one file cannot carry two rows under different casing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRow {
    pub op_id: String,
    pub batch_id: i64,
    /// `stamp`, `trim`, `stamp_undo` or `trim_undo`.
    pub kind: String,
    pub root_id: i64,
    pub rel_path: String,
    pub rel_key: String,
    pub temp_name: String,
    pub backup_name: String,
    pub pre_size: i64,
    pub pre_mtime: i64,
    /// `journaled`, `temp_synced` or `replaced`.
    pub phase: String,
    pub undo_json: Option<String>,
    pub target_undo_id: Option<i64>,
    pub created_at: i64,
}

/// What a stamp or trim records about a written file. Serialized into `undo_json` when the temp
/// file is synced, and inserted as an undo row by `finish_file`. A stamp carries `prior_json` and
/// `written_json`; a trim carries the backup and its expiry.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoDraft {
    pub track_id: Option<i64>,
    pub root_id: Option<i64>,
    pub root_path: String,
    pub rel_path: String,
    pub title: String,
    pub prior_json: Option<String>,
    pub written_json: Option<String>,
    pub cleared_edits_json: Option<String>,
    pub backup_name: Option<String>,
    pub backup_size: Option<i64>,
    pub post_size: i64,
    pub post_mtime: i64,
    pub expires_at: Option<i64>,
    /// A trim only: the original and the trimmed length.
    pub pre_duration_ms: Option<i64>,
    pub post_duration_ms: Option<i64>,
    /// Files to delete once the write is committed.
    pub sweep: Vec<SweepEntry>,
}

/// What an undo operation records in `undo_json`: the files to delete once the target row is
/// marked undone.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UndoMark {
    pub sweep: Vec<SweepEntry>,
}

/// One undo row. `sweep` is `sweep_json` parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoRow {
    pub id: i64,
    pub batch_id: i64,
    pub kind: String,
    pub track_id: Option<i64>,
    pub root_id: Option<i64>,
    pub root_path: String,
    pub rel_path: String,
    pub title: String,
    pub prior_json: Option<String>,
    pub written_json: Option<String>,
    pub cleared_edits_json: Option<String>,
    pub backup_name: Option<String>,
    pub backup_size: Option<i64>,
    pub post_size: i64,
    pub post_mtime: i64,
    pub expires_at: Option<i64>,
    pub undone_at: Option<i64>,
    pub sweep: Vec<SweepEntry>,
    pub pre_duration_ms: Option<i64>,
    pub post_duration_ms: Option<i64>,
}

/// What `finish_file` did. `undo_id` is the row it inserted, or the target it marked undone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedFile {
    pub undo_id: i64,
    /// True when this file was the batch's first written stamp file, which retired the previous
    /// stamp batch's undo rows.
    pub first_of_batch: bool,
}

const UNDO_COLUMNS: &str = "id, batch_id, kind, track_id, root_id, root_path, rel_path, title,
    prior_json, written_json, cleared_edits_json, backup_name, backup_size, post_size, post_mtime,
    expires_at, undone_at, sweep_json, pre_duration_ms, post_duration_ms";

const JOURNAL_COLUMNS: &str = "op_id, batch_id, kind, root_id, rel_path, rel_key, temp_name,
    backup_name, pre_size, pre_mtime, phase, undo_json, target_undo_id, created_at";

fn misuse(detail: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISUSE),
        Some(detail.into()),
    )
}

fn parse_sweep(json: Option<String>) -> Vec<SweepEntry> {
    json.and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

/// Empty lists are stored as NULL.
fn sweep_to_sql(sweep: &[SweepEntry]) -> Option<String> {
    (!sweep.is_empty()).then(|| serde_json::to_string(sweep).unwrap_or_default())
}

fn batch_from_row(r: &Row) -> rusqlite::Result<BatchRow> {
    Ok(BatchRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        started_at: r.get(2)?,
        finished_at: r.get(3)?,
        files_written: r.get(4)?,
        undone_at: r.get(5)?,
        label: r.get(6)?,
    })
}

fn journal_from_row(r: &Row) -> rusqlite::Result<JournalRow> {
    Ok(JournalRow {
        op_id: r.get(0)?,
        batch_id: r.get(1)?,
        kind: r.get(2)?,
        root_id: r.get(3)?,
        rel_path: r.get(4)?,
        rel_key: r.get(5)?,
        temp_name: r.get(6)?,
        backup_name: r.get(7)?,
        pre_size: r.get(8)?,
        pre_mtime: r.get(9)?,
        phase: r.get(10)?,
        undo_json: r.get(11)?,
        target_undo_id: r.get(12)?,
        created_at: r.get(13)?,
    })
}

fn undo_from_row(r: &Row) -> rusqlite::Result<UndoRow> {
    Ok(UndoRow {
        id: r.get(0)?,
        batch_id: r.get(1)?,
        kind: r.get(2)?,
        track_id: r.get(3)?,
        root_id: r.get(4)?,
        root_path: r.get(5)?,
        rel_path: r.get(6)?,
        title: r.get(7)?,
        prior_json: r.get(8)?,
        written_json: r.get(9)?,
        cleared_edits_json: r.get(10)?,
        backup_name: r.get(11)?,
        backup_size: r.get(12)?,
        post_size: r.get(13)?,
        post_mtime: r.get(14)?,
        expires_at: r.get(15)?,
        undone_at: r.get(16)?,
        sweep: parse_sweep(r.get(17)?),
        pre_duration_ms: r.get(18)?,
        post_duration_ms: r.get(19)?,
    })
}

fn undo_rows_where(
    conn: &Connection,
    clause: &str,
    args: &[&dyn rusqlite::ToSql],
) -> rusqlite::Result<Vec<UndoRow>> {
    conn.prepare(&format!(
        "SELECT {UNDO_COLUMNS} FROM file_write_undo WHERE {clause} ORDER BY id"
    ))?
    .query_map(args, undo_from_row)?
    .collect()
}

/// Opens a batch and returns its id.
pub fn begin_batch(
    conn: &Connection,
    kind: &str,
    label: Option<&str>,
    now: i64,
) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO file_write_batches (kind, label, started_at) VALUES (?1, ?2, ?3) RETURNING id",
        params![kind, label, now],
        |r| r.get(0),
    )
}

/// Stamps the batch's end time.
pub fn finish_batch(conn: &Connection, batch_id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE file_write_batches SET finished_at = ?2 WHERE id = ?1",
        params![batch_id, now],
    )?;
    Ok(())
}

/// Marks a batch undone, so the Settings line stops offering Undo.
pub fn mark_batch_undone(conn: &Connection, batch_id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE file_write_batches SET undone_at = ?2 WHERE id = ?1",
        params![batch_id, now],
    )?;
    Ok(())
}

/// The newest batch that wrote at least one file.
pub fn last_batch(conn: &Connection) -> rusqlite::Result<Option<BatchRow>> {
    conn.query_row(
        "SELECT id, kind, started_at, finished_at, files_written, undone_at, label
         FROM file_write_batches WHERE files_written > 0 ORDER BY id DESC LIMIT 1",
        [],
        batch_from_row,
    )
    .optional()
}

/// Inserts a journal row in phase `journaled`. `rel_key` is derived here with `normalize_path_key`;
/// the row's own `rel_key`, `phase` and `undo_json` are ignored. Fails on `UNIQUE(root_id, rel_key)`
/// when the file already has a row.
pub fn insert_journal(conn: &Connection, row: &JournalRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO file_write_journal
            (op_id, batch_id, kind, root_id, rel_path, rel_key, temp_name, backup_name,
             pre_size, pre_mtime, phase, target_undo_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'journaled', ?11, ?12)",
        params![
            row.op_id,
            row.batch_id,
            row.kind,
            row.root_id,
            row.rel_path,
            normalize_path_key(&row.rel_path),
            row.temp_name,
            row.backup_name,
            row.pre_size,
            row.pre_mtime,
            row.target_undo_id,
            row.created_at,
        ],
    )?;
    Ok(())
}

/// Moves a journal row to `phase`. `undo_json` is stored when given and kept otherwise.
pub fn set_phase(
    conn: &Connection,
    op_id: &str,
    phase: &str,
    undo_json: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE file_write_journal SET phase = ?2, undo_json = COALESCE(?3, undo_json)
         WHERE op_id = ?1",
        params![op_id, phase, undo_json],
    )?;
    Ok(())
}

/// Drops a journal row without recording an undo row: the file was rolled back or never written.
pub fn drop_journal(conn: &Connection, op_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM file_write_journal WHERE op_id = ?1",
        params![op_id],
    )?;
    Ok(())
}

/// Every journal row of one root, oldest first.
pub fn journal_rows(conn: &Connection, root_id: i64) -> rusqlite::Result<Vec<JournalRow>> {
    conn.prepare(&format!(
        "SELECT {JOURNAL_COLUMNS} FROM file_write_journal WHERE root_id = ?1
         ORDER BY created_at, op_id"
    ))?
    .query_map(params![root_id], journal_from_row)?
    .collect()
}

/// The roots that have at least one journal row.
pub fn journal_roots(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    conn.prepare("SELECT DISTINCT root_id FROM file_write_journal ORDER BY root_id")?
        .query_map([], |r| r.get(0))?
        .collect()
}

/// True when a journal row lies under `rel_prefix_key` in the root: the folder itself or any path
/// inside it. `rel_prefix_key` is in `normalize_path_key` form; an empty prefix is the whole root.
pub fn has_journal_under(
    conn: &Connection,
    root_id: i64,
    rel_prefix_key: &str,
) -> rusqlite::Result<bool> {
    let prefix = rel_prefix_key.trim_end_matches(['\\', '/']);
    if prefix.is_empty() {
        return conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM file_write_journal WHERE root_id = ?1)",
            params![root_id],
            |r| r.get(0),
        );
    }
    let inside = format!("{prefix}{}", std::path::MAIN_SEPARATOR);
    conn.query_row(
        "SELECT EXISTS (
            SELECT 1 FROM file_write_journal
            WHERE root_id = ?1
              AND (rel_key = ?2 OR substr(rel_key, 1, length(?3)) = ?3)
         )",
        params![root_id, prefix, inside],
        |r| r.get(0),
    )
}

/// Forgets a removed root's writes: its journal rows go, and its undo rows stay with no root. Their
/// `root_path` snapshot is what finds a kept backup afterwards. The journal rows must go with the
/// root because a root id can be reused, and a new root must not inherit them.
pub(super) fn forget_root_writes(conn: &Connection, root_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM file_write_journal WHERE root_id = ?1",
        params![root_id],
    )?;
    conn.execute(
        "UPDATE file_write_undo SET root_id = NULL WHERE root_id = ?1",
        params![root_id],
    )?;
    Ok(())
}

/// Hands the undo rows of the roots in `from` to root `to`, now at `root_path`. A row's `rel_path`
/// is below its root's path, and every caller moves roots so that this path holds those files.
pub(super) fn repoint_undo_rows(
    conn: &Connection,
    from: &[i64],
    to: i64,
    root_path: &str,
) -> rusqlite::Result<()> {
    for root_id in from {
        conn.execute(
            "UPDATE file_write_undo SET root_id = ?1, root_path = ?2 WHERE root_id = ?3",
            params![to, root_path, root_id],
        )?;
    }
    Ok(())
}

/// Retires a journal row and records its outcome in one transaction.
///
/// A `stamp` or `trim` row inserts the undo row described by its `undo_json` (an `UndoDraft`) and
/// counts the file on its batch. On a batch's first written stamp file the previous stamp batches'
/// undo rows are retired in the same transaction: a row with an empty sweep list is deleted, one
/// that still lists files loses its undo data and stays until `clear_sweep` empties the list. A
/// `stamp_undo` or `trim_undo` row marks its target `undone_at` and adds its `undo_json` (an
/// `UndoMark`) sweep list to it. Nothing is written when the row is missing or its JSON is bad.
pub fn finish_file(conn: &Connection, op_id: &str, now: i64) -> rusqlite::Result<FinishedFile> {
    let tx = conn.unchecked_transaction()?;
    let journal = tx
        .query_row(
            &format!("SELECT {JOURNAL_COLUMNS} FROM file_write_journal WHERE op_id = ?1"),
            params![op_id],
            journal_from_row,
        )
        .optional()?
        .ok_or_else(|| misuse(format!("no journal row {op_id}")))?;
    let json = journal
        .undo_json
        .as_deref()
        .ok_or_else(|| misuse(format!("journal row {op_id} has no undo_json")))?;

    let finished = match journal.kind.as_str() {
        "stamp" | "trim" => {
            let draft: UndoDraft =
                serde_json::from_str(json).map_err(|e| misuse(format!("undo_json: {e}")))?;
            if journal.kind == "stamp" && (draft.prior_json.is_none() || draft.written_json.is_none())
            {
                return Err(misuse("a stamp undo row needs prior_json and written_json"));
            }
            let first_of_batch = journal.kind == "stamp"
                && tx.query_row(
                    "SELECT files_written = 0 FROM file_write_batches WHERE id = ?1",
                    params![journal.batch_id],
                    |r| r.get::<_, bool>(0),
                )?;
            if first_of_batch {
                retire_previous_stamp_rows(&tx, journal.batch_id)?;
            }
            tx.execute(
                "INSERT INTO file_write_undo
                    (batch_id, kind, track_id, root_id, root_path, rel_path, title, prior_json,
                     written_json, cleared_edits_json, backup_name, backup_size, post_size,
                     post_mtime, expires_at, sweep_json, pre_duration_ms, post_duration_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    journal.batch_id,
                    journal.kind,
                    draft.track_id,
                    draft.root_id,
                    draft.root_path,
                    draft.rel_path,
                    draft.title,
                    draft.prior_json,
                    draft.written_json,
                    draft.cleared_edits_json,
                    draft.backup_name,
                    draft.backup_size,
                    draft.post_size,
                    draft.post_mtime,
                    draft.expires_at,
                    sweep_to_sql(&draft.sweep),
                    draft.pre_duration_ms,
                    draft.post_duration_ms,
                ],
            )?;
            let undo_id = tx.last_insert_rowid();
            tx.execute(
                "UPDATE file_write_batches SET files_written = files_written + 1 WHERE id = ?1",
                params![journal.batch_id],
            )?;
            FinishedFile {
                undo_id,
                first_of_batch,
            }
        }
        "stamp_undo" | "trim_undo" => {
            let mark: UndoMark =
                serde_json::from_str(json).map_err(|e| misuse(format!("undo_json: {e}")))?;
            let target = journal
                .target_undo_id
                .ok_or_else(|| misuse(format!("journal row {op_id} has no target")))?;
            let existing = tx
                .query_row(
                    "SELECT sweep_json FROM file_write_undo WHERE id = ?1",
                    params![target],
                    |r| r.get::<_, Option<String>>(0),
                )
                .optional()?;
            let undo_id = match existing {
                Some(current) => {
                    let mut sweep = parse_sweep(current);
                    sweep.extend(mark.sweep);
                    tx.execute(
                        "UPDATE file_write_undo SET undone_at = ?2, sweep_json = ?3 WHERE id = ?1",
                        params![target, now, sweep_to_sql(&sweep)],
                    )?;
                    target
                }
                // The target was retired or removed meanwhile: the file work is done, so the
                // files it left go on a sweep-only row that the sweep deletes once empty.
                None => insert_sweep_only(&tx, &journal, &mark.sweep, now)?,
            };
            FinishedFile {
                undo_id,
                first_of_batch: false,
            }
        }
        other => return Err(misuse(format!("unknown journal kind {other}"))),
    };

    tx.execute(
        "DELETE FROM file_write_journal WHERE op_id = ?1",
        params![op_id],
    )?;
    tx.commit()?;
    Ok(finished)
}

// A row that carries no undo data and only lists files to sweep. It takes the shape `clear_sweep`
// deletes when the list empties: a stamp row without priors, or a trim row marked undone.
fn insert_sweep_only(
    conn: &Connection,
    journal: &JournalRow,
    sweep: &[SweepEntry],
    now: i64,
) -> rusqlite::Result<i64> {
    let kind = journal.kind.trim_end_matches("_undo");
    conn.execute(
        "INSERT INTO file_write_undo
            (batch_id, kind, root_id, root_path, rel_path, title, post_size, post_mtime, undone_at,
             sweep_json)
         VALUES (?1, ?2, ?3, '', ?4, '', 0, 0, ?5, ?6)",
        params![
            journal.batch_id,
            kind,
            journal.root_id,
            journal.rel_path,
            now,
            sweep_to_sql(sweep),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

// Rows of other stamp batches: deleted when nothing is left to sweep, else stripped of their undo
// data. A row that a journaled undo still targets is left whole.
fn retire_previous_stamp_rows(conn: &Connection, batch_id: i64) -> rusqlite::Result<()> {
    const TARGETED: &str =
        "id NOT IN (SELECT target_undo_id FROM file_write_journal WHERE target_undo_id IS NOT NULL)";
    conn.execute(
        &format!(
            "DELETE FROM file_write_undo
             WHERE kind = 'stamp' AND batch_id != ?1 AND {TARGETED}
               AND (sweep_json IS NULL OR sweep_json = '[]')"
        ),
        params![batch_id],
    )?;
    conn.execute(
        &format!(
            "UPDATE file_write_undo
             SET prior_json = NULL, written_json = NULL, cleared_edits_json = NULL
             WHERE kind = 'stamp' AND batch_id != ?1 AND {TARGETED}"
        ),
        params![batch_id],
    )?;
    Ok(())
}

/// The undo rows of one batch.
pub fn undo_rows(conn: &Connection, batch_id: i64) -> rusqlite::Result<Vec<UndoRow>> {
    undo_rows_where(conn, "batch_id = ?1", &[&batch_id])
}

/// One undo row by id.
pub fn undo_row(conn: &Connection, id: i64) -> rusqlite::Result<Option<UndoRow>> {
    Ok(undo_rows_where(conn, "id = ?1", &[&id])?.pop())
}

/// Removes an undo row, as discarding a kept backup does once its file is deleted.
// Unused until the kept backups list can discard a backup.
#[allow(dead_code)]
pub fn delete_undo(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM file_write_undo WHERE id = ?1", params![id])?;
    Ok(())
}

/// The trim backups still kept: rows with a backup that have not been undone.
pub fn kept_backups(conn: &Connection) -> rusqlite::Result<Vec<UndoRow>> {
    undo_rows_where(
        conn,
        "kind = 'trim' AND backup_name IS NOT NULL AND undone_at IS NULL",
        &[],
    )
}

/// The kept backups whose expiry has passed.
// Unused until backups past their expiry are deleted.
#[allow(dead_code)]
pub fn expired_backups(conn: &Connection, now: i64) -> rusqlite::Result<Vec<UndoRow>> {
    undo_rows_where(
        conn,
        "kind = 'trim' AND backup_name IS NOT NULL AND undone_at IS NULL
         AND expires_at IS NOT NULL AND expires_at <= ?1",
        &[&now],
    )
}

/// Resets every kept backup's expiry to its batch's start plus `days`, or to never for `None`.
/// Returns the number of rows rewritten.
// Unused until changing how long backups are kept rewrites their expiry.
#[allow(dead_code)]
pub fn rewrite_expiry(conn: &Connection, days: Option<i64>) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE file_write_undo
         SET expires_at = CASE WHEN ?1 IS NULL THEN NULL ELSE
             (SELECT b.started_at FROM file_write_batches b WHERE b.id = file_write_undo.batch_id)
             + ?1 * ?2 END
         WHERE kind = 'trim' AND backup_name IS NOT NULL AND undone_at IS NULL",
        params![days, DAY_SECS],
    )
}

/// The undo rows that still list files to delete, for the sweeper.
pub fn sweep_rows(conn: &Connection) -> rusqlite::Result<Vec<UndoRow>> {
    undo_rows_where(
        conn,
        "sweep_json IS NOT NULL AND sweep_json != '[]'",
        &[],
    )
}

/// Removes the named files from an undo row's sweep list after they were deleted. A row with
/// nothing left to keep is deleted once its list is empty: a superseded stamp row (its undo data
/// gone) or an undone trim row.
pub fn clear_sweep(conn: &Connection, undo_id: i64, deleted: &[String]) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let current = tx
        .query_row(
            "SELECT sweep_json FROM file_write_undo WHERE id = ?1",
            params![undo_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .map(parse_sweep);
    let Some(mut sweep) = current else {
        return Ok(());
    };
    sweep.retain(|entry| !deleted.contains(&entry.name));
    tx.execute(
        "UPDATE file_write_undo SET sweep_json = ?2 WHERE id = ?1",
        params![undo_id, sweep_to_sql(&sweep)],
    )?;
    if sweep.is_empty() {
        tx.execute(
            "DELETE FROM file_write_undo
             WHERE id = ?1 AND ((kind = 'stamp' AND prior_json IS NULL AND written_json IS NULL)
                             OR (kind = 'trim' AND undone_at IS NOT NULL))",
            params![undo_id],
        )?;
    }
    tx.commit()
}

/// Every backup name an undo row keeps. Recovery never deletes or renames away a file with one.
pub fn backup_names(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    conn.prepare("SELECT backup_name FROM file_write_undo WHERE backup_name IS NOT NULL")?
        .query_map([], |r| r.get(0))?
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_in_memory;

    fn journal(op: &str, batch_id: i64, kind: &str, rel_path: &str) -> JournalRow {
        JournalRow {
            op_id: op.to_string(),
            batch_id,
            kind: kind.to_string(),
            root_id: 1,
            rel_path: rel_path.to_string(),
            rel_key: String::new(),
            temp_name: format!(".plisto-tmp-{op}-x"),
            backup_name: format!(".plisto-tmp-bak-{op}-x"),
            pre_size: 100,
            pre_mtime: 200,
            phase: String::new(),
            undo_json: None,
            target_undo_id: None,
            created_at: 10,
        }
    }

    fn stamp_draft(rel_path: &str, sweep: &[(&str, i64)]) -> UndoDraft {
        UndoDraft {
            root_path: "C:\\music".to_string(),
            rel_path: rel_path.to_string(),
            title: "Song".to_string(),
            prior_json: Some("{}".to_string()),
            written_json: Some("{}".to_string()),
            post_size: 110,
            post_mtime: 210,
            sweep: sweep
                .iter()
                .map(|(name, size)| SweepEntry {
                    name: name.to_string(),
                    size: *size,
                })
                .collect(),
            ..UndoDraft::default()
        }
    }

    fn trim_draft(rel_path: &str, expires_at: Option<i64>) -> UndoDraft {
        UndoDraft {
            backup_name: Some(format!(".plisto-tmp-bak-{rel_path}")),
            backup_size: Some(500),
            expires_at,
            pre_duration_ms: Some(261_000),
            post_duration_ms: Some(238_000),
            ..stamp_draft(rel_path, &[])
        }
    }

    // Journals one file, moves it to temp_synced with `draft`, and finishes it.
    fn write_file(
        conn: &Connection,
        batch_id: i64,
        op: &str,
        kind: &str,
        draft: &UndoDraft,
    ) -> FinishedFile {
        insert_journal(conn, &journal(op, batch_id, kind, &draft.rel_path)).unwrap();
        let json = serde_json::to_string(draft).unwrap();
        set_phase(conn, op, "temp_synced", Some(&json)).unwrap();
        finish_file(conn, op, 50).unwrap()
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn migration_from_v22_adds_the_tables_and_the_column() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::migrate(&conn).unwrap();
        // Step the version back to a v22 shape: the new objects are dropped, the rest stays.
        conn.execute_batch(
            "DROP INDEX file_write_undo_batch;
             DROP TABLE file_write_undo;
             DROP TABLE file_write_journal;
             DROP TABLE file_write_batches;
             ALTER TABLE tracks DROP COLUMN raw_genres;
             INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES ('/m/a.mp3', 'a.mp3', 'mp3', 1, 2, 3);",
        )
        .unwrap();
        conn.pragma_update(None, "user_version", 22).unwrap();

        let report = crate::db::migrations::migrate(&conn).unwrap();

        assert_eq!((report.from, report.to), (22, 23));
        let genres: Option<String> = conn
            .query_row("SELECT raw_genres FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(genres, None, "an existing row reads NULL, the re-read sentinel");
        assert_eq!(count(&conn, "file_write_batches"), 0);
        assert_eq!(count(&conn, "file_write_journal"), 0);
        assert_eq!(count(&conn, "file_write_undo"), 0);
        conn.prepare("SELECT pre_duration_ms, post_duration_ms FROM file_write_undo")
            .unwrap();
        conn.prepare("SELECT label FROM file_write_batches").unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_second_row_for_the_same_file_in_another_case_is_refused() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "stamp", None, 1).unwrap();
        insert_journal(&conn, &journal("a1", batch, "stamp", "Album\\Song.mp3")).unwrap();

        let second = insert_journal(&conn, &journal("b2", batch, "stamp", "album/SONG.mp3"));

        assert!(second.is_err());
        assert_eq!(count(&conn, "file_write_journal"), 1);
    }

    #[test]
    fn finish_file_inserts_the_undo_row_and_drops_the_journal_row() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "stamp", None, 1).unwrap();

        let done = write_file(
            &conn,
            batch,
            "a1",
            "stamp",
            &stamp_draft("a.mp3", &[("bak-a", 100)]),
        );

        assert!(done.first_of_batch);
        assert_eq!(count(&conn, "file_write_journal"), 0);
        let rows = undo_rows(&conn, batch).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].sweep.len(), 1);
        assert_eq!(last_batch(&conn).unwrap().unwrap().files_written, 1);
    }

    #[test]
    fn finish_file_changes_nothing_when_the_undo_json_is_bad() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "stamp", None, 1).unwrap();
        insert_journal(&conn, &journal("a1", batch, "stamp", "a.mp3")).unwrap();
        set_phase(&conn, "a1", "temp_synced", Some("not json")).unwrap();

        assert!(finish_file(&conn, "a1", 50).is_err());

        assert_eq!(count(&conn, "file_write_journal"), 1, "the row is still there");
        assert_eq!(count(&conn, "file_write_undo"), 0);
        assert_eq!(last_batch(&conn).unwrap(), None);
    }

    #[test]
    fn the_first_written_file_retires_the_previous_stamp_rows_and_keeps_trim_rows() {
        let conn = open_in_memory().unwrap();
        let first = begin_batch(&conn, "stamp", None, 1).unwrap();
        write_file(&conn, first, "a1", "stamp", &stamp_draft("a.mp3", &[]));
        write_file(
            &conn,
            first,
            "a2",
            "stamp",
            &stamp_draft("b.mp3", &[("bak-b", 100)]),
        );
        let trim = begin_batch(&conn, "trim", None, 2).unwrap();
        write_file(&conn, trim, "t1", "trim", &trim_draft("c.opus", None));

        let second = begin_batch(&conn, "stamp", None, 3).unwrap();
        let done = write_file(&conn, second, "c1", "stamp", &stamp_draft("d.mp3", &[]));
        let again = write_file(&conn, second, "c2", "stamp", &stamp_draft("e.mp3", &[]));

        assert!(done.first_of_batch);
        assert!(!again.first_of_batch, "only the first file retires");
        let left = undo_rows(&conn, first).unwrap();
        assert_eq!(left.len(), 1, "the row with nothing to sweep is gone");
        assert_eq!(left[0].prior_json, None, "the other lost its undo data");
        assert_eq!(left[0].written_json, None);
        assert_eq!(undo_rows(&conn, trim).unwrap().len(), 1);
        assert_eq!(undo_rows(&conn, second).unwrap().len(), 2);

        clear_sweep(&conn, left[0].id, &["bak-b".to_string()]).unwrap();
        assert!(undo_rows(&conn, first).unwrap().is_empty(), "swept, then deleted");
    }

    #[test]
    fn a_batch_that_writes_nothing_keeps_the_previous_undo_rows() {
        let conn = open_in_memory().unwrap();
        let first = begin_batch(&conn, "stamp", None, 1).unwrap();
        write_file(&conn, first, "a1", "stamp", &stamp_draft("a.mp3", &[]));

        let second = begin_batch(&conn, "stamp", None, 2).unwrap();
        insert_journal(&conn, &journal("b1", second, "stamp", "b.mp3")).unwrap();
        drop_journal(&conn, "b1").unwrap();
        finish_batch(&conn, second, 3).unwrap();

        let rows = undo_rows(&conn, first).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].prior_json.is_some());
        assert_eq!(last_batch(&conn).unwrap().unwrap().id, first);
    }

    #[test]
    fn an_undo_operation_marks_its_target_and_lists_its_sweep() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "trim", None, 1).unwrap();
        let target = write_file(&conn, batch, "t1", "trim", &trim_draft("a.opus", None)).undo_id;

        let mut undo = journal("u1", batch, "trim_undo", "a.opus");
        undo.target_undo_id = Some(target);
        insert_journal(&conn, &undo).unwrap();
        let mark = UndoMark {
            sweep: vec![SweepEntry {
                name: "keep".to_string(),
                size: 500,
            }],
        };
        set_phase(&conn, "u1", "replaced", Some(&serde_json::to_string(&mark).unwrap())).unwrap();
        let done = finish_file(&conn, "u1", 60).unwrap();

        assert_eq!(done.undo_id, target);
        let row = undo_row(&conn, target).unwrap().unwrap();
        assert_eq!(row.undone_at, Some(60));
        assert_eq!(row.sweep, mark.sweep);
        assert!(kept_backups(&conn).unwrap().is_empty());
        assert_eq!(sweep_rows(&conn).unwrap().len(), 1);
        assert_eq!(last_batch(&conn).unwrap().unwrap().files_written, 1, "not recounted");
    }

    #[test]
    fn deleting_a_track_clears_its_undo_link_and_keeps_the_row() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO tracks (id, source_path, filename, ext, size_bytes, mtime, scanned_at)
             VALUES (7, '/m/a.mp3', 'a.mp3', 'mp3', 1, 2, 3)",
            [],
        )
        .unwrap();
        let batch = begin_batch(&conn, "trim", None, 1).unwrap();
        let draft = UndoDraft {
            track_id: Some(7),
            ..trim_draft("a.opus", None)
        };
        let id = write_file(&conn, batch, "t1", "trim", &draft).undo_id;

        conn.execute("DELETE FROM tracks WHERE id = 7", []).unwrap();

        let row = undo_row(&conn, id).unwrap().unwrap();
        assert_eq!(row.track_id, None);
    }

    #[test]
    fn journal_queries_find_rows_by_root_and_by_folder() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "stamp", None, 1).unwrap();
        let sep = std::path::MAIN_SEPARATOR;
        let inside = format!("sub{sep}song.mp3");
        insert_journal(&conn, &journal("a1", batch, "stamp", &inside)).unwrap();
        let mut other = journal("b2", batch, "stamp", "x.mp3");
        other.root_id = 2;
        insert_journal(&conn, &other).unwrap();

        assert_eq!(journal_roots(&conn).unwrap(), vec![1, 2]);
        assert_eq!(journal_rows(&conn, 1).unwrap().len(), 1);
        assert!(has_journal_under(&conn, 1, &normalize_path_key("sub")).unwrap());
        assert!(!has_journal_under(&conn, 1, &normalize_path_key("su")).unwrap());
        assert!(!has_journal_under(&conn, 2, &normalize_path_key("sub")).unwrap());
        assert!(has_journal_under(&conn, 2, "").unwrap(), "empty prefix is the root");

        drop_journal(&conn, "a1").unwrap();
        assert_eq!(journal_roots(&conn).unwrap(), vec![2]);
    }

    #[test]
    fn kept_backups_expire_and_follow_a_changed_limit() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "trim", None, 1_000).unwrap();
        write_file(&conn, batch, "t1", "trim", &trim_draft("a.opus", Some(5_000)));
        let other = begin_batch(&conn, "trim", None, 2_000).unwrap();
        write_file(&conn, other, "t2", "trim", &trim_draft("b.opus", None));

        let kept = kept_backups(&conn).unwrap();
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].pre_duration_ms, Some(261_000));
        assert_eq!(kept[0].post_duration_ms, Some(238_000));
        assert!(expired_backups(&conn, 4_999).unwrap().is_empty());
        assert_eq!(expired_backups(&conn, 5_000).unwrap().len(), 1);

        assert_eq!(rewrite_expiry(&conn, Some(7)).unwrap(), 2);
        let expiries: Vec<Option<i64>> = kept_backups(&conn)
            .unwrap()
            .iter()
            .map(|r| r.expires_at)
            .collect();
        assert_eq!(
            expiries,
            vec![Some(1_000 + 7 * DAY_SECS), Some(2_000 + 7 * DAY_SECS)]
        );

        rewrite_expiry(&conn, None).unwrap();
        assert!(expired_backups(&conn, i64::MAX).unwrap().is_empty());
    }

    #[test]
    fn backup_names_lists_every_kept_backup() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "trim", None, 1).unwrap();
        write_file(&conn, batch, "t1", "trim", &trim_draft("a.opus", None));
        write_file(&conn, batch, "t2", "trim", &trim_draft("b.opus", None));

        let names = backup_names(&conn).unwrap();

        assert_eq!(names.len(), 2);
        assert!(names.contains(".plisto-tmp-bak-a.opus"));
    }

    #[test]
    fn clear_sweep_removes_only_the_named_files() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "stamp", None, 1).unwrap();
        let id = write_file(
            &conn,
            batch,
            "a1",
            "stamp",
            &stamp_draft("a.mp3", &[("one", 1), ("two", 2)]),
        )
        .undo_id;

        clear_sweep(&conn, id, &["one".to_string()]).unwrap();

        let row = undo_row(&conn, id).unwrap().unwrap();
        assert_eq!(row.sweep.len(), 1);
        assert_eq!(row.sweep[0].name, "two");
        assert!(row.prior_json.is_some(), "a live row is never deleted by a sweep");
    }

    #[test]
    fn a_failure_after_the_retire_step_rolls_the_retire_back() {
        let conn = open_in_memory().unwrap();
        let first = begin_batch(&conn, "stamp", None, 1).unwrap();
        write_file(&conn, first, "a1", "stamp", &stamp_draft("a.mp3", &[]));

        let second = begin_batch(&conn, "stamp", None, 2).unwrap();
        // A dangling track id fails the INSERT, which runs after the retire.
        let draft = UndoDraft {
            track_id: Some(999),
            ..stamp_draft("b.mp3", &[])
        };
        insert_journal(&conn, &journal("b1", second, "stamp", "b.mp3")).unwrap();
        let json = serde_json::to_string(&draft).unwrap();
        set_phase(&conn, "b1", "temp_synced", Some(&json)).unwrap();

        assert!(finish_file(&conn, "b1", 50).is_err());

        let rows = undo_rows(&conn, first).unwrap();
        assert_eq!(rows.len(), 1, "the previous row was not deleted");
        assert!(rows[0].prior_json.is_some());
        assert_eq!(count(&conn, "file_write_journal"), 1);
        assert_eq!(last_batch(&conn).unwrap().unwrap().id, first);
    }

    // Journals an undo of `target` and moves it to `replaced` with a one-file sweep list.
    fn journal_undo(conn: &Connection, batch: i64, op: &str, kind: &str, target: i64) {
        let mut undo = journal(op, batch, kind, "a.mp3");
        undo.target_undo_id = Some(target);
        insert_journal(conn, &undo).unwrap();
        let mark = UndoMark {
            sweep: vec![SweepEntry {
                name: "bak".to_string(),
                size: 9,
            }],
        };
        let json = serde_json::to_string(&mark).unwrap();
        set_phase(conn, op, "replaced", Some(&json)).unwrap();
    }

    #[test]
    fn retirement_skips_a_row_a_journaled_undo_targets() {
        let conn = open_in_memory().unwrap();
        let first = begin_batch(&conn, "stamp", None, 1).unwrap();
        let target = write_file(&conn, first, "a1", "stamp", &stamp_draft("a.mp3", &[])).undo_id;
        journal_undo(&conn, first, "u1", "stamp_undo", target);

        let second = begin_batch(&conn, "stamp", None, 2).unwrap();
        write_file(&conn, second, "b1", "stamp", &stamp_draft("b.mp3", &[]));

        let row = undo_row(&conn, target).unwrap().expect("the target survives");
        assert!(row.prior_json.is_some(), "and keeps its undo data");

        let done = finish_file(&conn, "u1", 60).unwrap();
        assert_eq!(done.undo_id, target);
        assert_eq!(count(&conn, "file_write_journal"), 0);
    }

    #[test]
    fn an_undo_whose_target_is_gone_still_finishes_onto_a_sweep_only_row() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "stamp", None, 1).unwrap();
        journal_undo(&conn, batch, "u1", "stamp_undo", 4242);

        let done = finish_file(&conn, "u1", 60).unwrap();

        assert_eq!(count(&conn, "file_write_journal"), 0, "the file is not blocked");
        let row = undo_row(&conn, done.undo_id).unwrap().unwrap();
        assert_eq!(row.sweep.len(), 1);
        assert_eq!(row.prior_json, None);
        clear_sweep(&conn, row.id, &["bak".to_string()]).unwrap();
        assert_eq!(count(&conn, "file_write_undo"), 0, "swept, then deleted");
    }

    #[test]
    fn clear_sweep_deletes_an_undone_trim_row_once_empty() {
        let conn = open_in_memory().unwrap();
        let batch = begin_batch(&conn, "trim", None, 1).unwrap();
        let target = write_file(&conn, batch, "t1", "trim", &trim_draft("a.opus", None)).undo_id;
        journal_undo(&conn, batch, "u1", "trim_undo", target);
        finish_file(&conn, "u1", 60).unwrap();
        assert!(backup_names(&conn).unwrap().contains(".plisto-tmp-bak-a.opus"));

        clear_sweep(&conn, target, &["bak".to_string()]).unwrap();

        assert!(undo_row(&conn, target).unwrap().is_none());
        assert!(backup_names(&conn).unwrap().is_empty(), "the name is released");
    }

    #[test]
    fn a_batch_keeps_its_label() {
        let conn = open_in_memory().unwrap();
        let id = begin_batch(&conn, "stamp", Some("Abbey Road"), 1).unwrap();
        write_file(&conn, id, "a1", "stamp", &stamp_draft("a.mp3", &[]));

        let last = last_batch(&conn).unwrap().unwrap();

        assert_eq!(last.label.as_deref(), Some("Abbey Road"));
    }
}
