/*
 * Recovery of writes a crash or a failed step left half done. Each journal row is settled from what
 * the disk holds: the source, its temp and its backup are read, and the row is rolled back, completed
 * or left for the user. A file an undo row keeps as its backup is never deleted or renamed away. The
 * sweep then deletes the files committed writes listed, each only while its size still matches.
 */

// -- Module Declarations --
mod sweep;

// -- Library Imports --
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use rusqlite::Connection;

// -- Local Imports --
use super::attrs::{clear_hidden, set_hidden};
use super::replace::{replace, ReplaceOutcome};
use crate::db;
use crate::db::file_writes::{
    backup_names, drop_journal, finish_file, journal_roots, journal_rows, undo_row, JournalRow,
};
use crate::dto::WriteRecovery;
use crate::scan::{file_stats_checked, root_reachable};

pub use sweep::sweep_pending;
pub(super) use sweep::sweep_row;

// A dead network share can hang a folder listing for tens of seconds; launch never waits that long.
const BOOT_REACH_DEADLINE: Duration = Duration::from_secs(2);

/// What recovery did with one journal row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowOutcome {
    /// The replace never ran: the temp is gone and so is the row.
    Dropped,
    /// The original is back under the source name. The row stays only when the temp could not be
    /// deleted, which the next run settles as `Dropped`.
    Restored,
    /// The write had committed on disk; its undo row was recorded.
    Finished,
    /// The finished temp was moved into place with no original left; the row is gone.
    Moved,
    /// Nothing safe could be done; the row and the files are kept as they are.
    Held,
}

/// Settles one journal row under `root`. Also the inline path a writer takes when a step fails.
pub fn recover_row(
    conn: &Connection,
    root: &Path,
    row: &JournalRow,
    now: i64,
) -> rusqlite::Result<RowOutcome> {
    // An empty path, one that could leave the root or replace it outright, or a temp or backup name
    // that is more than a file name, is never acted on.
    let rel = Path::new(&row.rel_path);
    let inside = rel.components().next().is_some()
        && rel.components().all(|c| matches!(c, Component::Normal(_)));
    if !inside || !file_name_only(&row.temp_name) || !file_name_only(&row.backup_name) {
        eprintln!(
            "[file_writes] holding {}: {:?} or its names leave the folder",
            row.op_id, row.rel_path
        );
        return Ok(RowOutcome::Held);
    }
    let protected = backup_names(conn)?;
    let source = root.join(rel);
    let Some(dir) = source.parent().map(Path::to_path_buf) else {
        return Ok(RowOutcome::Held);
    };
    let place = Place {
        temp: dir.join(&row.temp_name),
        backup: dir.join(&row.backup_name),
        temp_kept: protected.contains(&row.temp_name),
        backup_kept: protected.contains(&row.backup_name),
        source,
    };
    let (Ok(source_now), Ok(temp_now), Ok(backup_now)) =
        (stat(&place.source), stat(&place.temp), stat(&place.backup))
    else {
        return Ok(RowOutcome::Held);
    };
    let synced = row.phase != "journaled";
    let matches_pre = source_now == Some((row.pre_size, row.pre_mtime));
    let (has_temp, has_backup) = (temp_now.is_some(), backup_now.is_some());

    // In order: the replace never ran; it ran; the source is gone and the original waits; only the
    // finished temp is left; the write committed and its backup was lost. Anything else is held.
    let outcome = match (source_now.is_some(), has_temp, has_backup) {
        (true, _, false) if matches_pre => {
            if has_temp && !place.temp_kept && !remove(&place.temp) {
                return Ok(RowOutcome::Held);
            }
            RowOutcome::Dropped
        }
        (true, false, true) if !matches_pre && !place.backup_kept => swap_back(&place),
        (false, _, true) if !place.backup_kept => rename_back(&place),
        (false, true, false) if synced && !place.temp_kept => {
            if fs::rename(&place.temp, &place.source).is_err() {
                return Ok(RowOutcome::Held);
            }
            RowOutcome::Moved
        }
        (true, false, false)
            if synced && row.undo_json.is_some() && committed(conn, row, &dir, source_now)? =>
        {
            return Ok(match finish_file(conn, &row.op_id, now) {
                Ok(_) => RowOutcome::Finished,
                Err(e) => {
                    eprintln!(
                        "[file_writes] cannot finish {}: {e}",
                        place.source.display()
                    );
                    RowOutcome::Held
                }
            });
        }
        _ => RowOutcome::Held,
    };
    if outcome != RowOutcome::Held && !place.temp_left() {
        drop_journal(conn, &row.op_id)?;
    }
    Ok(outcome)
}

// Whether a changed source with no temp or backup left can be taken as the written file. A forward
// write is. An undo is only when the source has the recorded size of the kept backup it puts back
// and the size and mtime of that backup on disk, which the undo's copy keeps; finishing it sweeps
// the backup. With no size recorded, as for a stamp undo, or the backup gone, it is held.
fn committed(
    conn: &Connection,
    row: &JournalRow,
    dir: &Path,
    source_now: Option<(i64, i64)>,
) -> rusqlite::Result<bool> {
    if row.kind != "trim_undo" {
        return Ok(!row.kind.ends_with("_undo"));
    }
    let undo = match row.target_undo_id {
        Some(id) => undo_row(conn, id)?,
        None => None,
    };
    let kept = undo.and_then(|u| u.backup_size.zip(u.backup_name));
    let Some((size, name)) = kept.filter(|(_, name)| file_name_only(name)) else {
        return Ok(false);
    };
    let kept_now = stat(&dir.join(&name)).ok().flatten();
    Ok(kept_now.is_some_and(|(kept_size, _)| kept_size == size) && kept_now == source_now)
}

// True for a single file name: one normal component and no separator.
fn file_name_only(name: &str) -> bool {
    let mut parts = Path::new(name).components();
    matches!(parts.next(), Some(Component::Normal(_)))
        && parts.next().is_none()
        && !name.contains(['\\', '/'])
}

/// The three names of one row, and which of them an undo row keeps as its backup.
struct Place {
    source: PathBuf,
    temp: PathBuf,
    backup: PathBuf,
    temp_kept: bool,
    backup_kept: bool,
}

impl Place {
    /// True while a temp recovery must delete is still on disk; its row then stays for the next run.
    fn temp_left(&self) -> bool {
        !self.temp_kept && self.temp.exists()
    }
}

// The replace ran: the backup goes back over the source, and the written file lands under the temp
// name, which is then deleted. An error 1177 leaves the source gone, which `rename_back` settles.
fn swap_back(place: &Place) -> RowOutcome {
    match replace(&place.source, &place.backup, &place.temp) {
        Ok(ReplaceOutcome::Replaced) => {
            let _ = clear_hidden(&place.source);
            if place.temp_kept {
                // An undo's temp is a kept backup, and the swap has just put its bytes back.
                let _ = set_hidden(&place.temp);
            } else {
                remove(&place.temp);
            }
            RowOutcome::Restored
        }
        Ok(ReplaceOutcome::OriginalAtBackup) => rename_back(place),
        _ => RowOutcome::Held,
    }
}

// The source is gone and the original waits under the backup name.
fn rename_back(place: &Place) -> RowOutcome {
    if fs::rename(&place.backup, &place.source).is_err() {
        return RowOutcome::Held;
    }
    let _ = clear_hidden(&place.source);
    if !place.temp_kept {
        remove(&place.temp);
    }
    RowOutcome::Restored
}

/// Settles every journal row of one reachable root into `report`. On an error, `report` keeps what
/// the rows before it settled.
pub fn recover_root(
    conn: &Connection,
    root_id: i64,
    root: &Path,
    now: i64,
    report: &mut WriteRecovery,
) -> rusqlite::Result<()> {
    for row in journal_rows(conn, root_id)? {
        match recover_row(conn, root, &row, now)? {
            RowOutcome::Dropped => {}
            RowOutcome::Restored => report.restored += 1,
            RowOutcome::Finished => report.finished += 1,
            RowOutcome::Moved | RowOutcome::Held => report.flag(
                &row.op_id,
                root.join(&row.rel_path).to_string_lossy().into_owned(),
            ),
        }
    }
    Ok(())
}

/// Counts every journal row of a root that does not answer as held offline.
pub fn held_offline(
    conn: &Connection,
    root_id: i64,
    report: &mut WriteRecovery,
) -> rusqlite::Result<()> {
    for row in journal_rows(conn, root_id)? {
        report.flag_offline(&row.op_id);
    }
    Ok(())
}

/// The scan's run for one root: its rows are settled when it is reachable and counted as held
/// offline otherwise. What was found goes to `found` before any error returns; an error means a
/// reachable root sits the pass out.
pub fn recover_for_scan(
    conn: &Connection,
    root_id: i64,
    root: &Path,
    reachable: bool,
    now: i64,
    found: impl FnOnce(WriteRecovery),
) -> rusqlite::Result<()> {
    let mut report = WriteRecovery::default();
    let settled = if reachable {
        recover_root(conn, root_id, root, now, &mut report)
    } else {
        held_offline(conn, root_id, &mut report)
    };
    if !report.is_empty() {
        found(report);
    }
    settled
}

/// The launch run: every root with journal rows is recovered into `report` when it answers within
/// the deadline, and counted as held offline otherwise. The sweep follows, reusing what was learned
/// of each root. On an error, `report` keeps what was settled before it.
pub fn recover_at_boot(
    conn: &Connection,
    now: i64,
    report: &mut WriteRecovery,
) -> rusqlite::Result<()> {
    let mut seen: HashMap<PathBuf, bool> = HashMap::new();
    let mut reachable = |path: &Path| {
        *seen
            .entry(path.to_path_buf())
            .or_insert_with(|| reachable_within(path, BOOT_REACH_DEADLINE, root_reachable))
    };
    for root_id in journal_roots(conn)? {
        match db::root_target(conn, root_id)? {
            Some((_, path)) if reachable(Path::new(&path)) => {
                recover_root(conn, root_id, Path::new(&path), now, report)?;
            }
            _ => held_offline(conn, root_id, report)?,
        }
    }
    sweep_pending(conn, reachable)
}

/// Whether `probe` answers true for the root within `deadline`. The probe runs on its own thread,
/// which is left to finish on its own when the deadline passes.
fn reachable_within(path: &Path, deadline: Duration, probe: fn(&Path) -> bool) -> bool {
    let (tx, rx) = mpsc::channel();
    let path = path.to_path_buf();
    thread::spawn(move || {
        let _ = tx.send(probe(&path));
    });
    rx.recv_timeout(deadline).unwrap_or(false)
}

// Size and mtime as the scan reads them, None when the file is absent. Any other error is returned,
// and the caller then holds the row rather than act on a guess.
fn stat(path: &Path) -> io::Result<Option<(i64, i64)>> {
    match file_stats_checked(path) {
        Ok(found) => Ok(Some(found)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

// Deletes a file; true when it is gone, whether deleted now or already absent.
fn remove(path: &Path) -> bool {
    match fs::remove_file(path) {
        Ok(()) => true,
        Err(e) => e.kind() == io::ErrorKind::NotFound,
    }
}

#[cfg(test)]
mod fault_tests;
#[cfg(test)]
mod sweep_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod undo_tests;
