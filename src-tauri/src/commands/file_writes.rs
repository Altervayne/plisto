/*
 * The IPC command surface for writes to the user's music files that is not one writer's own: the
 * recovery report the front end takes once, the last batch for the Settings line, and the guard every
 * writing command passes before it touches a file.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::State;

// -- Local Imports --
use crate::db;
use crate::db::file_writes::{last_batch, undo_rows};
use crate::dto::{LastFileWrite, WriteRecovery};
use crate::state::AppState;

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
// Unused until a command writes a music file in place.
#[allow(dead_code)]
pub enum WriteRefusal {
    /// The kind's switch in Settings is off.
    Off,
    /// A library or playlist export is running.
    ExportRunning,
    /// Another write is running.
    Running,
}

/// Marks a write as running while it lives, and clears the mark when dropped.
// Unused until a command writes a music file in place.
#[allow(dead_code)]
pub struct FileWriteRun<'a> {
    state: &'a AppState,
}

impl Drop for FileWriteRun<'_> {
    fn drop(&mut self) {
        self.state.file_write_running.store(false, Ordering::SeqCst);
    }
}

/// Lets a write of `kind` (`stamp` or `trim`) start: its switch must be on, no export may run and no
/// other write may be running. The cancel flag is reset for the new run.
// Unused until a command writes a music file in place.
#[allow(dead_code)]
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
    if state.export_running.load(Ordering::SeqCst)
        || state.playlist_export_running.load(Ordering::SeqCst)
    {
        return Err(WriteRefusal::ExportRunning);
    }
    state.file_write_cancel.store(false, Ordering::SeqCst);
    Ok(run)
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

        state.file_write_cancel.store(true, Ordering::SeqCst);
        let _run = write_guard(&state, "trim").unwrap();
        assert!(!state.file_write_cancel.load(Ordering::SeqCst));
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
