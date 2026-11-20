/*
 * Putting a trimmed file's kept original back. The kept backup is copied to a fresh temp with its
 * mtime and swapped in, so the backup itself never moves: a crash before the swap leaves it whole,
 * and recovery takes an interrupted undo as committed only when the source matches it on disk. Once
 * the trim's row is marked undone, the backup and the trimmed file swapped out are swept.
 */

// -- Library Imports --
use std::fs;
use std::path::Path;

// -- Local Imports --
use super::{json, swap, Halt, TrimFailure, TrimFile, WriteRun};
use crate::db::file_writes::{
    finish_file, insert_journal, mark_batch_undone, set_phase, undo_row, JournalRow, SweepEntry,
    UndoMark, UndoRow,
};
use crate::file_writes::attrs::{clear_hidden, set_hidden};
use crate::file_writes::fault::Step;
use crate::file_writes::names::{backup_name, new_op_id, temp_name};
use crate::file_writes::recover::sweep_row;
use crate::file_writes::replace::sync_path;

/// Puts the original of the trim `undo` back over `file`, which the caller found still is the
/// trimmed file. Returns the track ids the re-read changed.
pub fn undo_trim(run: &mut WriteRun, file: &TrimFile, undo: &UndoRow) -> Result<Vec<i64>, Halt> {
    let (Some(kept), Some(kept_size)) = (undo.backup_name.as_deref(), undo.backup_size) else {
        return Err(Halt::Failed(TrimFailure::Unavailable("no kept backup")));
    };
    let name = file.name()?;
    let op = new_op_id()?;
    let row = JournalRow {
        op_id: op.clone(),
        batch_id: undo.batch_id,
        kind: "trim_undo".to_string(),
        root_id: file.root_id,
        rel_path: file.rel_path.clone(),
        rel_key: String::new(),
        temp_name: temp_name(&op, name),
        backup_name: backup_name(&op, name),
        pre_size: file.size,
        pre_mtime: file.mtime,
        phase: String::new(),
        undo_json: None,
        target_undo_id: Some(undo.id),
        created_at: run.now,
    };
    insert_journal(run.conn, &row)?;
    run.fault.check(Step::Journaled)?;

    let mark = UndoMark {
        sweep: vec![
            SweepEntry {
                name: kept.to_string(),
                size: kept_size,
            },
            SweepEntry {
                name: row.backup_name.clone(),
                size: file.size,
            },
        ],
    };
    match write_undo(run, file, undo, &row, &mark) {
        Err(Halt::Failed(why)) => {
            run.settle(file, &row.op_id);
            Err(Halt::Failed(why))
        }
        done => done,
    }
}

fn write_undo(
    run: &mut WriteRun,
    file: &TrimFile,
    undo: &UndoRow,
    row: &JournalRow,
    mark: &UndoMark,
) -> Result<Vec<i64>, Halt> {
    let dir = file.dir()?;
    let (kept, kept_size) = (dir.join(&mark.sweep[0].name), mark.sweep[0].size);
    let (temp, backup) = (dir.join(&row.temp_name), dir.join(&row.backup_name));
    // A backup of another size is no longer the original the trim set aside.
    let kept_md = fs::metadata(&kept)
        .ok()
        .filter(|md| md.is_file() && md.len() as i64 == kept_size)
        .ok_or(Halt::Failed(TrimFailure::Missing))?;
    fs::copy(&kept, &temp)?;
    clear_hidden(&temp)?;
    // Recovery recognises the put-back file by the backup's size and mtime.
    fs::File::options()
        .write(true)
        .open(&temp)?
        .set_modified(kept_md.modified()?)?;
    check_copied(&temp, kept_size)?;
    run.fault.check(Step::TempWritten)?;

    sync_path(&temp)?;
    set_phase(run.conn, &row.op_id, "temp_synced", Some(&json(mark)?))?;
    run.fault.check(Step::TempSynced)?;

    swap(&file.source, &temp, &backup)?;
    // The trimmed file is swept next; hidden, it stays out of sight if that delete fails.
    let _ = set_hidden(&backup);
    set_phase(run.conn, &row.op_id, "replaced", None)?;
    run.fault.check(Step::Replaced)?;

    sync_path(&file.source)?;
    run.fault.check(Step::SourceSynced)?;

    let finished = finish_file(run.conn, &row.op_id, run.now)?;
    let _ = mark_batch_undone(run.conn, undo.batch_id, run.now);
    run.fault.check(Step::Finished)?;

    // A file the sweep cannot delete now stays listed, and the next sweep retries it.
    let swept = undo_row(run.conn, finished.undo_id)
        .and_then(|marked| marked.map_or(Ok(()), |marked| sweep_row(run.conn, &marked, dir)));
    if let Err(e) = swept {
        eprintln!("[file_writes] cannot sweep after undo {}: {e}", undo.id);
    }
    run.fault.check(Step::Swept)?;

    Ok(super::reread_file(
        run.conn,
        &file.source,
        file.root_id,
        run.now,
    ))
}

/// Refuses a put-back copy that is not as long as the backup it was copied from, which then changed
/// or was cut short under it.
pub(super) fn check_copied(temp: &Path, kept_size: i64) -> Result<(), Halt> {
    if fs::metadata(temp)?.len() as i64 != kept_size {
        return Err(Halt::Failed(TrimFailure::Missing));
    }
    Ok(())
}
