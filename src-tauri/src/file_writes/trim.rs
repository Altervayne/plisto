/*
 * Trimming a library Opus file in place, and putting its original back. The cut is written beside
 * the file under a temp name and swapped in with `ReplaceFileW`; the original stays under a hidden
 * backup name that the trim's undo row keeps. Only the Opus cutter runs, which copies the packets
 * and the OpusTags verbatim, so no tag is rewritten. Every step is journaled: a failed step settles
 * its row through recovery before the error returns, and a crash leaves the row for the next launch
 * or scan.
 */

// -- Module Declarations --
mod undo;

// -- Library Imports --
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use windows::Win32::Foundation::ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;

// -- Local Imports --
use super::attrs::set_hidden;
use super::fault::{Aborted, Fault, Step};
use super::names::{backup_name, new_op_id, temp_name};
use super::recover::{recover_row, RowOutcome};
use super::replace::{replace, sync_path, ReplaceOutcome};
use crate::db;
use crate::db::file_writes::{
    begin_batch, finish_batch, finish_file, insert_journal, journal_rows, set_phase, JournalRow,
    UndoDraft, DAY_SECS,
};
use crate::dto::{Segment, WriteRecovery};
use crate::scan::file_stats_checked;
use crate::scan::retry::reread_paths;
use crate::splice::{cut_segment, CutError, Format};

pub use undo::undo_trim;

/// Opus always decodes at 48 kHz, the clock a segment's frames count in.
const OPUS_RATE: i64 = 48_000;

/// Why a trim or its undo did not happen. Displayed, it is the string the editor parses: the kind,
/// then any detail after a colon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrimFailure {
    Locked,
    Space,
    Denied,
    Changed,
    InUse,
    Offline,
    Missing,
    /// An export or another job holds the library.
    Busy(&'static str),
    /// The switch is off, the file is not Opus, or it is not a library track.
    Unavailable(&'static str),
    /// Anything else, led by the Windows code when there is one.
    Other(String),
    /// Cancel was asked before the swap.
    Cancelled,
}

impl fmt::Display for TrimFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TrimFailure::Locked => f.write_str("locked"),
            TrimFailure::Space => f.write_str("space"),
            TrimFailure::Denied => f.write_str("denied"),
            TrimFailure::Changed => f.write_str("changed"),
            TrimFailure::InUse => f.write_str("inUse"),
            TrimFailure::Offline => f.write_str("offline"),
            TrimFailure::Missing => f.write_str("missing"),
            TrimFailure::Busy(why) => write!(f, "busy: {why}"),
            TrimFailure::Unavailable(why) => write!(f, "unavailable: {why}"),
            TrimFailure::Other(detail) => write!(f, "other: {detail}"),
            TrimFailure::Cancelled => f.write_str("cancelled"),
        }
    }
}

impl TrimFailure {
    /// The kind of a file system error, by its Windows code.
    pub fn of_io(e: &io::Error) -> TrimFailure {
        match e.raw_os_error() {
            Some(5) => TrimFailure::Denied,
            Some(32 | 33) => TrimFailure::Locked,
            Some(39 | 112) => TrimFailure::Space,
            Some(code) => TrimFailure::Other(code.to_string()),
            None => TrimFailure::Other(e.to_string()),
        }
    }

    /// The kind of an index error.
    pub fn of_db(e: &rusqlite::Error) -> TrimFailure {
        TrimFailure::Other(e.to_string())
    }

    // A cut or a replace that failed on a file another program holds. Access denied there is a
    // handle that does not share delete, so it reads as locked like a sharing violation.
    fn of_held(code: i64) -> TrimFailure {
        match code {
            5 | 32 | 33 => TrimFailure::Locked,
            39 | 112 => TrimFailure::Space,
            _ => TrimFailure::Other(code.to_string()),
        }
    }
}

/// How a write stopped short.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Halt {
    /// The write failed; its journal row was settled.
    Failed(TrimFailure),
    /// The fault seam stopped it after this step, leaving files and rows as a crash would.
    Aborted(Step),
}

impl fmt::Display for Halt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Halt::Failed(why) => why.fmt(f),
            Halt::Aborted(step) => write!(f, "other: stopped after {step:?}"),
        }
    }
}

impl From<TrimFailure> for Halt {
    fn from(why: TrimFailure) -> Self {
        Halt::Failed(why)
    }
}

impl From<Aborted> for Halt {
    fn from(stop: Aborted) -> Self {
        Halt::Aborted(stop.0)
    }
}

impl From<io::Error> for Halt {
    fn from(e: io::Error) -> Self {
        Halt::Failed(TrimFailure::of_io(&e))
    }
}

impl From<rusqlite::Error> for Halt {
    fn from(e: rusqlite::Error) -> Self {
        Halt::Failed(TrimFailure::of_db(&e))
    }
}

/// A library file the refusals passed, as it is on disk now.
#[derive(Debug, Clone, PartialEq)]
pub struct TrimFile {
    pub track_id: i64,
    pub root_id: i64,
    pub root: PathBuf,
    /// The path below `root`, in its real case; `source` is the two joined.
    pub rel_path: String,
    pub source: PathBuf,
    /// The title snapshot an undo row shows.
    pub title: String,
    pub size: i64,
    pub mtime: i64,
    pub duration_ms: Option<i64>,
}

impl TrimFile {
    fn name(&self) -> Result<&str, Halt> {
        self.source
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or(Halt::Failed(TrimFailure::Unavailable(
                "the file has no name",
            )))
    }

    fn dir(&self) -> Result<&Path, Halt> {
        self.source
            .parent()
            .ok_or(Halt::Failed(TrimFailure::Unavailable(
                "the file has no folder",
            )))
    }
}

/// One write's context: its index connection, the fault seam, the clock, and the rows an inline
/// recovery could not settle, which the caller reports.
pub struct WriteRun<'a> {
    pub conn: &'a Connection,
    pub fault: Fault,
    pub now: i64,
    pub left: WriteRecovery,
}

impl<'a> WriteRun<'a> {
    pub fn new(conn: &'a Connection, fault: Fault, now: i64) -> Self {
        WriteRun {
            conn,
            fault,
            now,
            left: WriteRecovery::default(),
        }
    }

    // Settles the row of a failed write as recovery does after a crash. Whatever cannot be settled
    // stays for the next launch or scan, and is reported.
    fn settle(&mut self, file: &TrimFile, op_id: &str) {
        let row = journal_rows(self.conn, file.root_id)
            .map(|rows| rows.into_iter().find(|row| row.op_id == op_id));
        let outcome = match row {
            Ok(Some(row)) => recover_row(self.conn, &file.root, &row, self.now),
            Ok(None) => return,
            Err(e) => Err(e),
        };
        match outcome {
            Ok(RowOutcome::Dropped | RowOutcome::Restored | RowOutcome::Finished) => {}
            Ok(RowOutcome::Moved | RowOutcome::Held) => {
                let path = file.source.to_string_lossy().into_owned();
                self.left.flag(op_id, path);
            }
            Err(e) => {
                eprintln!("[file_writes] cannot settle {op_id}: {e}");
                let path = file.source.to_string_lossy().into_owned();
                self.left.flag(op_id, path);
            }
        }
    }
}

/// A committed trim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trimmed {
    pub undo_id: i64,
    pub backup_name: String,
    /// Epoch seconds; None keeps the backup until it is discarded.
    pub expires_at: Option<i64>,
    /// The track ids the re-read changed.
    pub reread: Vec<i64>,
}

/// Opens the connection a write journals on, with every commit synced to the disk before the next
/// file step.
pub fn open_write_conn(db_path: &Path) -> rusqlite::Result<Connection> {
    let conn = db::open_db(db_path)?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    Ok(conn)
}

/// Trims `file` to `segment` in place. `keep_days` sets the backup's expiry from the batch's start,
/// None keeps it until discarded. `cancelled` is asked at each step until the swap.
pub fn trim_in_place(
    run: &mut WriteRun,
    file: &TrimFile,
    segment: &Segment,
    keep_days: Option<i64>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Trimmed, Halt> {
    stop_if_cancelled(cancelled)?;
    let name = file.name()?;
    let op = new_op_id()?;
    let row = JournalRow {
        op_id: op.clone(),
        batch_id: begin_batch(run.conn, "trim", Some(&file.title), run.now)?,
        kind: "trim".to_string(),
        root_id: file.root_id,
        rel_path: file.rel_path.clone(),
        rel_key: String::new(),
        temp_name: temp_name(&op, name),
        backup_name: backup_name(&op, name),
        pre_size: file.size,
        pre_mtime: file.mtime,
        phase: String::new(),
        undo_json: None,
        target_undo_id: None,
        created_at: run.now,
    };
    insert_journal(run.conn, &row)?;
    run.fault.check(Step::Journaled)?;

    match write_trim(run, file, &row, segment, keep_days, cancelled) {
        Err(Halt::Failed(why)) => {
            run.settle(file, &row.op_id);
            let _ = finish_batch(run.conn, row.batch_id, run.now);
            Err(Halt::Failed(why))
        }
        done => done,
    }
}

fn write_trim(
    run: &mut WriteRun,
    file: &TrimFile,
    row: &JournalRow,
    segment: &Segment,
    keep_days: Option<i64>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Trimmed, Halt> {
    let dir = file.dir()?;
    let (temp, backup) = (dir.join(&row.temp_name), dir.join(&row.backup_name));
    stop_if_cancelled(cancelled)?;
    cut_segment(&file.source, Format::Opus, segment, &temp).map_err(|e| match e {
        CutError::Io(code) => TrimFailure::of_held(code.into()),
        e => TrimFailure::Other(e.to_string()),
    })?;
    run.fault.check(Step::TempWritten)?;

    sync_path(&temp)?;
    let (post_size, post_mtime) = file_stats_checked(&temp)?;
    let frames = segment.end_frame.saturating_sub(segment.start_frame) as i64;
    let mut draft = UndoDraft {
        track_id: Some(file.track_id),
        root_id: Some(file.root_id),
        root_path: file.root.to_string_lossy().into_owned(),
        rel_path: row.rel_path.clone(),
        title: file.title.clone(),
        backup_name: Some(row.backup_name.clone()),
        backup_size: Some(file.size),
        post_size,
        post_mtime,
        expires_at: keep_days.map(|days| run.now + days * DAY_SECS),
        pre_duration_ms: file.duration_ms,
        post_duration_ms: Some(frames * 1000 / OPUS_RATE),
        ..UndoDraft::default()
    };
    set_phase(run.conn, &row.op_id, "temp_synced", Some(&json(&draft)?))?;
    run.fault.check(Step::TempSynced)?;
    stop_if_cancelled(cancelled)?;

    swap(&file.source, &temp, &backup)?;
    // A backup left visible is still safe: the scan skips the staging prefix.
    let _ = set_hidden(&backup);
    set_phase(run.conn, &row.op_id, "replaced", None)?;
    run.fault.check(Step::Replaced)?;

    sync_path(&file.source)?;
    // The undo compares the file against these values, so they are read off the source itself.
    let synced = file_stats_checked(&file.source)?;
    if synced != (post_size, post_mtime) {
        (draft.post_size, draft.post_mtime) = synced;
        set_phase(run.conn, &row.op_id, "replaced", Some(&json(&draft)?))?;
    }
    run.fault.check(Step::SourceSynced)?;

    let finished = finish_file(run.conn, &row.op_id, run.now)?;
    let _ = finish_batch(run.conn, row.batch_id, run.now);
    run.fault.check(Step::Finished)?;

    Ok(Trimmed {
        undo_id: finished.undo_id,
        backup_name: row.backup_name.clone(),
        expires_at: draft.expires_at,
        reread: reread_file(run.conn, &file.source, file.root_id, run.now),
    })
}

fn stop_if_cancelled(cancelled: &dyn Fn() -> bool) -> Result<(), Halt> {
    if cancelled() {
        return Err(Halt::Failed(TrimFailure::Cancelled));
    }
    Ok(())
}

fn json<T: serde::Serialize>(value: &T) -> Result<String, Halt> {
    serde_json::to_string(value).map_err(|e| Halt::Failed(TrimFailure::Other(e.to_string())))
}

/// Replaces `source` with `temp`, keeping the original under `backup`.
fn swap(source: &Path, temp: &Path, backup: &Path) -> Result<(), Halt> {
    let code = match replace(source, temp, backup)? {
        ReplaceOutcome::Replaced => return Ok(()),
        ReplaceOutcome::NothingMoved { code } | ReplaceOutcome::Failed { code } => code,
        ReplaceOutcome::OriginalAtBackup => ERROR_UNABLE_TO_MOVE_REPLACEMENT_2.0,
    };
    Err(Halt::Failed(TrimFailure::of_held(code.into())))
}

/// Reads `source` back into the library and returns the track ids that changed. A write stands
/// whether or not this works: a failure is logged and the next scan reads the file.
pub fn reread_file(conn: &Connection, source: &Path, root_id: i64, now: i64) -> Vec<i64> {
    let read = conn.unchecked_transaction().and_then(|tx| {
        let ids = reread_paths(&tx, &[(source.to_path_buf(), root_id)], now)?;
        tx.commit().map(|()| ids)
    });
    read.unwrap_or_else(|e| {
        eprintln!("[file_writes] cannot re-read {}: {e}", source.display());
        Vec::new()
    })
}

#[cfg(test)]
mod fault_tests;
#[cfg(test)]
pub(crate) mod tests;
