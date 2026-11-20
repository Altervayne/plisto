/*
 * The IPC command surface for writes to the user's music files that is not one writer's own: the
 * recovery report the front end takes once, the last batch for the Settings line, and the guard every
 * writing command passes before it touches a file.
 */

// -- Library Imports --
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::State;

// -- Local Imports --
use crate::db;
use crate::db::file_writes::{journal_rows, last_batch, undo_rows};
use crate::dto::{LastFileWrite, WriteRecovery};
use crate::scan_lock::WRITE_BUSY;
use crate::state::AppState;

/// The error a root command gets while files under it have unfinished writes.
pub const UNFINISHED_WRITES: &str = "unfinished writes";

/// What recovery settled since the last call, then cleared. None when nothing happened.
#[tauri::command]
pub fn take_file_write_recovery(state: State<'_, AppState>) -> Option<WriteRecovery> {
    state
        .write_recovery
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// The newest batch that wrote a file, for the Settings line. None before the first.
#[tauri::command]
pub fn last_file_write(state: State<'_, AppState>) -> Result<Option<LastFileWrite>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    read_last_file_write(&conn).map_err(|e| e.to_string())
}

// The batch with its time in epoch milliseconds. It can be undone while it is not marked undone and
// one of its files still has what an undo needs: a stamp's prior values or a trim's kept backup.
fn read_last_file_write(conn: &rusqlite::Connection) -> rusqlite::Result<Option<LastFileWrite>> {
    let Some(batch) = last_batch(conn)? else {
        return Ok(None);
    };
    let undoable = batch.undone_at.is_none()
        && undo_rows(conn, batch.id)?.iter().any(|row| {
            row.undone_at.is_none()
                && match row.kind.as_str() {
                    "stamp" => row.prior_json.is_some(),
                    "trim" => row.backup_name.is_some(),
                    _ => false,
                }
        });
    Ok(Some(LastFileWrite {
        batch_id: batch.id,
        at: batch.finished_at.unwrap_or(batch.started_at) * 1000,
        files: batch.files_written,
        kind: batch.kind,
        label: batch.label,
        undoable,
    }))
}

/// Why a writing command was refused before it touched a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteRefusal {
    /// The kind's switch in Settings is off.
    Off,
    /// A library or playlist export is running.
    ExportRunning,
    /// Another write is running.
    Running,
}

/// Marks a write as running while it lives. Dropped, it clears the mark and any cancel asked of it.
pub struct FileWriteRun<'a> {
    state: &'a AppState,
}

impl Drop for FileWriteRun<'_> {
    fn drop(&mut self) {
        self.state.file_write_running.store(false, Ordering::SeqCst);
        self.state.file_write_cancel.store(false, Ordering::SeqCst);
    }
}

/// Lets a write of `kind` (`stamp` or `trim`) start: its switch must be on, no export may run and no
/// other write may be running.
pub fn write_guard<'a>(state: &'a AppState, kind: &str) -> Result<FileWriteRun<'a>, WriteRefusal> {
    let key = match kind {
        "stamp" => "stampFiles",
        "trim" => "trimReplace",
        _ => return Err(WriteRefusal::Off),
    };
    let on = state
        .db
        .lock()
        .ok()
        .and_then(|conn| db::get_setting(&conn, key).ok().flatten())
        .is_some_and(|value| value == "1");
    if !on {
        return Err(WriteRefusal::Off);
    }
    if state.file_write_running.swap(true, Ordering::SeqCst) {
        return Err(WriteRefusal::Running);
    }
    let run = FileWriteRun { state };
    if export_active(state) {
        return Err(WriteRefusal::ExportRunning);
    }
    Ok(run)
}

// One side of the export handshake: a file write sets its flag and then reads this, an export sets
// its own flag and then reads `file_write_running`. Both orders are SeqCst, so at least one side
// sees the other and refuses.
fn export_active(state: &AppState) -> bool {
    state.export_running.load(Ordering::SeqCst)
        || state.playlist_export_running.load(Ordering::SeqCst)
}

/// Marks an export as running through `flag` (the library or the playlist export's own flag) and
/// refuses with the file-write busy error when a write to a music file runs. A refused export leaves
/// its flag clear. `running` is the error for a second export of the same kind.
pub fn begin_export(state: &AppState, flag: &AtomicBool, running: &str) -> Result<(), String> {
    if flag.swap(true, Ordering::SeqCst) {
        return Err(running.to_string());
    }
    if state.file_write_running.load(Ordering::SeqCst) {
        flag.store(false, Ordering::SeqCst);
        return Err(WRITE_BUSY.to_string());
    }
    Ok(())
}

/// Refuses a structural command (restore, purge, locate, relocate, remove) while a write to a music
/// file runs, since the command would move or replace what the write is on. Called once the command
/// holds the scan lock, so a write cannot start between the check and the work.
pub fn refuse_while_writing(state: &AppState) -> Result<(), String> {
    if state.file_write_running.load(Ordering::SeqCst) {
        return Err(WRITE_BUSY.to_string());
    }
    Ok(())
}

/// The absolute path of every file of root `root_id` that has an unfinished write, for the confirm
/// that names what a removal forgets. Empty for an unknown root.
#[tauri::command]
pub fn pending_writes(root_id: i64, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    pending_paths(&conn, root_id).map_err(|e| e.to_string())
}

pub(crate) fn pending_paths(
    conn: &rusqlite::Connection,
    root_id: i64,
) -> rusqlite::Result<Vec<String>> {
    let Some((_, root)) = db::root_target(conn, root_id)? else {
        return Ok(Vec::new());
    };
    Ok(journal_rows(conn, root_id)?
        .into_iter()
        .map(|row| Path::new(&root).join(row.rel_path).to_string_lossy().into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::file_writes::{begin_batch, finish_file, insert_journal, set_phase};
    use crate::db::file_writes::{JournalRow, UndoDraft};
    use std::path::PathBuf;

    fn state() -> AppState {
        AppState::for_test(db::open_in_memory().unwrap(), PathBuf::new())
    }

    fn switch_on(state: &AppState, key: &str) {
        db::set_setting(&state.db.lock().unwrap(), key, "1").unwrap();
    }

    #[test]
    fn the_guard_refuses_while_the_switch_is_off_or_another_job_runs() {
        let state = state();
        assert_eq!(write_guard(&state, "trim").err(), Some(WriteRefusal::Off));
        switch_on(&state, "trimReplace");
        assert_eq!(write_guard(&state, "stamp").err(), Some(WriteRefusal::Off));

        let run = write_guard(&state, "trim").unwrap();
        assert!(state.file_write_running.load(Ordering::SeqCst));
        assert_eq!(
            write_guard(&state, "trim").err(),
            Some(WriteRefusal::Running)
        );
        drop(run);
        assert!(!state.file_write_running.load(Ordering::SeqCst));

        state.playlist_export_running.store(true, Ordering::SeqCst);
        assert_eq!(
            write_guard(&state, "trim").err(),
            Some(WriteRefusal::ExportRunning)
        );
        assert!(!state.file_write_running.load(Ordering::SeqCst));
        state.playlist_export_running.store(false, Ordering::SeqCst);

        let run = write_guard(&state, "trim").unwrap();
        state.file_write_cancel.store(true, Ordering::SeqCst);
        drop(run);
        assert!(!state.file_write_cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn an_export_and_a_file_write_exclude_each_other_in_both_orders() {
        let state = state();
        switch_on(&state, "trimReplace");
        let kinds = [
            (&state.export_running, "an export is already running"),
            (
                &state.playlist_export_running,
                "a playlist export is already running",
            ),
        ];
        for (flag, running) in kinds {
            // The export is first: the write is refused and the export keeps its flag.
            begin_export(&state, flag, running).unwrap();
            assert_eq!(write_guard(&state, "trim").err(), Some(WriteRefusal::ExportRunning));
            assert_eq!(begin_export(&state, flag, running), Err(running.to_string()));
            assert!(flag.load(Ordering::SeqCst));
            flag.store(false, Ordering::SeqCst);

            // The write is first: the export is refused and leaves its flag clear.
            let run = write_guard(&state, "trim").unwrap();
            assert_eq!(begin_export(&state, flag, running), Err(WRITE_BUSY.to_string()));
            assert!(!flag.load(Ordering::SeqCst));
            drop(run);
            assert!(begin_export(&state, flag, running).is_ok());
            flag.store(false, Ordering::SeqCst);
        }
    }

    #[test]
    fn a_structural_command_is_refused_while_a_write_runs() {
        let state = state();
        assert_eq!(refuse_while_writing(&state), Ok(()));
        state.file_write_running.store(true, Ordering::SeqCst);
        assert_eq!(refuse_while_writing(&state), Err("a file write is running".to_string()));
    }

    #[test]
    fn pending_writes_list_the_files_of_that_root_only() {
        let conn = db::open_in_memory().unwrap();
        let one = db::insert_root(&conn, "/music", "/music", 1).unwrap();
        let two = db::insert_root(&conn, "/other", "/other", 1).unwrap();
        let batch = begin_batch(&conn, "trim", None, 1).unwrap();
        for (root, rel) in [(one, "a.opus"), (one, "b.opus"), (two, "c.opus")] {
            let row = JournalRow {
                op_id: rel.to_string(),
                batch_id: batch,
                kind: "trim".to_string(),
                root_id: root,
                rel_path: rel.to_string(),
                rel_key: String::new(),
                temp_name: "t".to_string(),
                backup_name: "b".to_string(),
                pre_size: 1,
                pre_mtime: 1,
                phase: "journaled".to_string(),
                undo_json: None,
                target_undo_id: None,
                created_at: 1,
            };
            insert_journal(&conn, &row).unwrap();
        }
        let listed = pending_paths(&conn, one).unwrap();
        let want = |name: &str| Path::new("/music").join(name).to_string_lossy().into_owned();
        assert_eq!(listed, vec![want("a.opus"), want("b.opus")]);
        assert!(pending_paths(&conn, 99).unwrap().is_empty());
    }

    #[test]
    fn the_recovery_report_is_taken_once() {
        let state = state();
        state.note_write_recovery(WriteRecovery::default());
        assert!(state.write_recovery.lock().unwrap().is_none());
        let mut found = WriteRecovery::default();
        found.restored = 1;
        state.note_write_recovery(found.clone());
        state.note_write_recovery(found);
        let taken = state.write_recovery.lock().unwrap().take();
        assert_eq!(taken.map(|r| r.restored), Some(2));
        assert!(state.write_recovery.lock().unwrap().is_none());
    }

    #[test]
    fn a_held_row_is_reported_once_a_session() {
        let state = state();
        let held = |op: &str| {
            let mut found = WriteRecovery::default();
            found.flag(op, format!("C:\\music\\{op}.opus"));
            found.flag_offline(op);
            found
        };
        state.note_write_recovery(held("a"));
        state.note_write_recovery(held("a"));
        let first = state.write_recovery.lock().unwrap().take().unwrap();
        assert_eq!(first.needs_attention, ["C:\\music\\a.opus"]);
        assert_eq!(first.held_offline, 1);

        state.note_write_recovery(held("a"));
        assert!(state.write_recovery.lock().unwrap().is_none());
        state.note_write_recovery(held("b"));
        let next = state.write_recovery.lock().unwrap().take().unwrap();
        assert_eq!(
            (next.needs_attention, next.held_offline),
            (vec!["C:\\music\\b.opus".to_string()], 1)
        );
    }

    fn write_trim(conn: &rusqlite::Connection, op: &str, backup: Option<&str>) -> i64 {
        let batch = begin_batch(conn, "trim", Some("Song"), 100).unwrap();
        insert_journal(
            conn,
            &JournalRow {
                op_id: op.to_string(),
                batch_id: batch,
                kind: "trim".to_string(),
                root_id: 1,
                rel_path: format!("{op}.opus"),
                rel_key: String::new(),
                temp_name: format!("t-{op}"),
                backup_name: format!("b-{op}"),
                pre_size: 1,
                pre_mtime: 1,
                phase: String::new(),
                undo_json: None,
                target_undo_id: None,
                created_at: 100,
            },
        )
        .unwrap();
        let draft = UndoDraft {
            backup_name: backup.map(str::to_string),
            ..UndoDraft::default()
        };
        let json = serde_json::to_string(&draft).unwrap();
        set_phase(conn, op, "replaced", Some(&json)).unwrap();
        finish_file(conn, op, 120).unwrap();
        batch
    }

    #[test]
    fn the_last_write_is_undoable_only_while_its_backup_is_kept() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(read_last_file_write(&conn).unwrap(), None);

        let batch = write_trim(&conn, "a", Some("b-a"));
        let last = read_last_file_write(&conn).unwrap().unwrap();
        assert_eq!((last.batch_id, last.files, last.at), (batch, 1, 100_000));
        assert_eq!(
            (last.kind.as_str(), last.label.as_deref()),
            ("trim", Some("Song"))
        );
        assert!(last.undoable);

        write_trim(&conn, "b", None);
        assert!(!read_last_file_write(&conn).unwrap().unwrap().undoable);
    }
}
