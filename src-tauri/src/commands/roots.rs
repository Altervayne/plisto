/*
 * The IPC command surface for the library of roots: list the folders, add one (an overlap guard,
 * a row insert, then an incremental scan of just that folder), remove one (a cascade drop plus the
 * emptied-container cleanup), rescan one or all, and read a removal's blast radius. Every mutation
 * takes the app-level scan lock before writing, so only one writer ever touches the WAL at a time.
 * The scanning commands mirror scan_workspace: reset the cancel flag, prep under a brief lock, then
 * run the walk on a blocking thread awaited so the runtime stays free to cancel. Adding or removing
 * a root tells the library sync to re-read the roots.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::ipc::Channel;
use tauri::State;

// -- Local Imports --
use super::file_writes::{pending_paths, refuse_while_writing, UNFINISHED_WRITES};
use super::restore_points::point_before;
use crate::bootlog::BootLog;
use crate::db;
use crate::db::file_writes::journal_rows;
use crate::dto::{Root, RootRemovalImpact, ScanProgress, ScanSummary, WriteRecovery};
use crate::library_sync::SyncCmd;
use crate::normalize::normalize_path_key;
use crate::scan::{self, ScanEmit};
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

/// Every library root with its live track count, ordered by id. Read-only.
#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Result<Vec<Root>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::list_roots(&conn).map_err(|e| e.to_string())
}

/// Adds `path` as a new root and scans just that folder into the index, streaming progress over
/// `on_progress`. Rejects while another scan runs, and rejects a folder that nests inside or
/// contains a folder already in the library (the disjoint-roots invariant). The row is inserted
/// under the write lock before the walk; the reconcile is scoped to the new root, so the rest of
/// the library is untouched.
#[tauri::command]
pub async fn add_root(
    path: String,
    on_progress: Channel<ScanProgress>,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    let _lock = acquire_scan_lock(&state, Holder::User)?;
    state.cancel.store(false, Ordering::SeqCst);
    let scanned_at = super::now_unix();

    // Reject an overlap and insert the root under the write lock, before the walk.
    let root = (|| -> Result<scan::ScanRoot, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let existing = db::all_root_paths(&conn).map_err(|e| e.to_string())?;
        if crate::paths::any_overlap(&existing, Path::new(&path)) {
            return Err("this folder overlaps a folder already in your library".to_string());
        }
        let key = normalize_path_key(&path);
        let id = db::insert_root(&conn, &key, &path, scanned_at).map_err(|e| e.to_string())?;
        Ok(scan::ScanRoot {
            id,
            path: PathBuf::from(&path),
            units: None,
        })
    })()?;
    let _ = state.library_sync.send(SyncCmd::RootsChanged);

    run_scan_blocking(&state, vec![root], scanned_at, on_progress).await
}

/// Removes a root and everything under it, in one transaction: the cascade drops its tracks and
/// their album memberships, and any album or single left empty is deleted. Rejects while a scan or
/// a write to a music file runs. A root with unfinished writes is refused unless `drop_pending_writes`
/// forgets them; either way the root's journal rows go with it, and its kept backups stay listed with
/// no root. No walk. Async so the wait for a preempted background pass never holds the main thread. A
/// restore point is staged first; a point that cannot be taken is logged and the removal still runs.
#[tauri::command]
pub async fn remove_root(
    id: i64,
    drop_pending_writes: bool,
    state: State<'_, AppState>,
    boot_log: State<'_, BootLog>,
) -> Result<(), String> {
    let _lock = acquire_scan_lock(&state, Holder::User)?;
    let result = remove_checked(&state, id, drop_pending_writes, || {
        point_before(&state, &boot_log, "remove_root")
    });
    let _ = state.library_sync.send(SyncCmd::RootsChanged);
    result
}

// The removal itself, under the scan lock: refused while a file write runs or rows are pending.
fn remove_checked(
    state: &AppState,
    id: i64,
    drop_pending_writes: bool,
    point: impl FnOnce() -> bool,
) -> Result<(), String> {
    refuse_while_writing(state)?;
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    let pending = pending_paths(&conn, id).map_err(|e| e.to_string())?;
    if !pending.is_empty() {
        if !drop_pending_writes {
            return Err(UNFINISHED_WRITES.to_string());
        }
        for file in &pending {
            eprintln!("[file_writes] dropping the unfinished write of {file}");
        }
        // A source already gone leaves the original only under the backup name, so those are named too.
        if let (Ok(rows), Ok(Some((_, root)))) =
            (journal_rows(&conn, id), db::root_target(&conn, id))
        {
            for row in rows {
                let source = Path::new(&root).join(&row.rel_path);
                let dir = source.parent().unwrap_or(Path::new(&root));
                eprintln!(
                    "[file_writes] temp {} and backup {} may be left behind",
                    dir.join(&row.temp_name).display(),
                    dir.join(&row.backup_name).display()
                );
            }
        }
    }
    point();
    db::remove_root(&mut conn, id).map_err(|e| e.to_string())
}

/// Rescans one root incrementally, streaming progress over `on_progress`. Rejects while another
/// scan runs or when the id is absent. The reconcile is scoped to this root, so no other root's
/// rows are flagged missing.
#[tauri::command]
pub async fn rescan_root(
    id: i64,
    on_progress: Channel<ScanProgress>,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    let _lock = acquire_scan_lock(&state, Holder::User)?;
    state.cancel.store(false, Ordering::SeqCst);
    let scanned_at = super::now_unix();

    let target = (|| -> Result<Option<(i64, String)>, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::root_target(&conn, id).map_err(|e| e.to_string())
    })()?;
    let Some((rid, path)) = target else {
        return Err("no such folder".to_string());
    };
    let root = scan::ScanRoot {
        id: rid,
        path: PathBuf::from(path),
        units: None,
    };

    run_scan_blocking(&state, vec![root], scanned_at, on_progress).await
}

/// Rescans every root, streaming progress over `on_progress`. The reconcile spans all roots (the
/// global sweep). Rejects while another scan runs.
#[tauri::command]
pub async fn rescan_all(
    on_progress: Channel<ScanProgress>,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    let _lock = acquire_scan_lock(&state, Holder::User)?;
    state.cancel.store(false, Ordering::SeqCst);
    let scanned_at = super::now_unix();

    let targets = (|| -> Result<Vec<(i64, String)>, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::root_targets(&conn).map_err(|e| e.to_string())
    })()?;
    let roots: Vec<scan::ScanRoot> = targets
        .into_iter()
        .map(|(id, path)| scan::ScanRoot {
            id,
            path: PathBuf::from(path),
            units: None,
        })
        .collect();

    run_scan_blocking(&state, roots, scanned_at, on_progress).await
}

/// The blast radius of removing `id`, for the counted confirm: how many tracks the root holds, how
/// many albums shrink or are deleted, and how many playlist entries and plays go with its tracks.
/// Read-only.
#[tauri::command]
pub fn root_removal_impact(
    id: i64,
    state: State<'_, AppState>,
) -> Result<RootRemovalImpact, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::root_removal_impact(&conn, id).map_err(|e| e.to_string())
}

/// Runs the root-aware scan on a blocking thread and awaits it, so the runtime stays free to
/// service a cancel. The caller holds the scan lock; this only spawns the walk. What the pass settled
/// of unfinished writes is noted for the front end whatever the outcome.
pub(super) async fn run_scan_blocking(
    state: &State<'_, AppState>,
    roots: Vec<scan::ScanRoot>,
    scanned_at: i64,
    on_progress: Channel<ScanProgress>,
) -> Result<ScanSummary, String> {
    let db_path = state.db_path.clone();
    let cancel = Arc::clone(&state.cancel);
    let recovered = Arc::new(Mutex::new(WriteRecovery::default()));
    let sink = Arc::clone(&recovered);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        scan::run_scan(
            &roots,
            &db_path,
            &cancel,
            scanned_at,
            &HashMap::new(),
            move |e| match e {
                ScanEmit::Recovered(found) => {
                    sink.lock().unwrap_or_else(|e| e.into_inner()).merge(found)
                }
                e => super::forward_progress(&on_progress, e),
            },
        )
    })
    .await;
    let found = std::mem::take(&mut *recovered.lock().unwrap_or_else(|e| e.into_inner()));
    state.note_write_recovery(found);
    match outcome {
        Ok(result) => result,
        Err(_) => Err("scan task failed to run".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::file_writes::{
        begin_batch, finish_file, insert_journal, journal_rows, kept_backups, set_phase,
        JournalRow, UndoDraft,
    };
    use rusqlite::Connection;

    fn state() -> AppState {
        AppState::for_test(db::open_in_memory().unwrap(), PathBuf::new())
    }

    fn add_root(state: &AppState, path: &str) -> i64 {
        let conn = state.db.lock().unwrap();
        db::insert_root(&conn, &normalize_path_key(path), path, 1).unwrap()
    }

    fn journal(conn: &Connection, root_id: i64, op: &str) {
        let batch = begin_batch(conn, "trim", None, 1).unwrap();
        let row = JournalRow {
            op_id: op.to_string(),
            batch_id: batch,
            kind: "trim".to_string(),
            root_id,
            rel_path: format!("{op}.opus"),
            rel_key: String::new(),
            temp_name: format!("t-{op}"),
            backup_name: format!("b-{op}"),
            pre_size: 1,
            pre_mtime: 1,
            phase: "journaled".to_string(),
            undo_json: None,
            target_undo_id: None,
            created_at: 1,
        };
        insert_journal(conn, &row).unwrap();
    }

    // A finished trim of `root_id` whose original is kept as a backup.
    fn kept_backup(conn: &Connection, root_id: i64, root_path: &str) {
        journal(conn, root_id, "kept");
        let draft = UndoDraft {
            root_id: Some(root_id),
            root_path: root_path.to_string(),
            rel_path: "kept.opus".to_string(),
            backup_name: Some("b-kept".to_string()),
            backup_size: Some(5),
            ..UndoDraft::default()
        };
        let json = serde_json::to_string(&draft).unwrap();
        set_phase(conn, "kept", "replaced", Some(&json)).unwrap();
        finish_file(conn, "kept", 2).unwrap();
    }

    fn removed(state: &AppState, id: i64, drop: bool) -> Result<(), String> {
        remove_checked(state, id, drop, || true)
    }

    #[test]
    fn a_root_with_unfinished_writes_is_refused_without_the_flag() {
        let state = state();
        let id = add_root(&state, "/Music");
        journal(&state.db.lock().unwrap(), id, "a");

        assert_eq!(removed(&state, id, false), Err("unfinished writes".to_string()));
        let conn = state.db.lock().unwrap();
        assert_eq!(db::root_target(&conn, id).unwrap().map(|r| r.0), Some(id));
        assert_eq!(journal_rows(&conn, id).unwrap().len(), 1);
    }

    #[test]
    fn the_flag_drops_the_rows_with_the_root() {
        let state = state();
        let id = add_root(&state, "/Music");
        journal(&state.db.lock().unwrap(), id, "a");

        assert_eq!(removed(&state, id, true), Ok(()));
        let conn = state.db.lock().unwrap();
        assert_eq!(db::root_target(&conn, id).unwrap(), None);
        assert!(journal_rows(&conn, id).unwrap().is_empty());
    }

    #[test]
    fn a_root_without_rows_is_removed_without_the_flag() {
        let state = state();
        let id = add_root(&state, "/Music");
        assert_eq!(removed(&state, id, false), Ok(()));
    }

    #[test]
    fn a_removal_is_refused_while_a_file_write_runs() {
        let state = state();
        let id = add_root(&state, "/Music");
        state.file_write_running.store(true, Ordering::SeqCst);
        assert_eq!(removed(&state, id, true), Err("a file write is running".to_string()));
        assert!(db::root_target(&state.db.lock().unwrap(), id).unwrap().is_some());
    }

    #[test]
    fn a_kept_backup_survives_the_removal_with_its_root_path() {
        let state = state();
        let id = add_root(&state, "/Music");
        kept_backup(&state.db.lock().unwrap(), id, "/Music");

        assert_eq!(removed(&state, id, false), Ok(()));
        let conn = state.db.lock().unwrap();
        let kept = kept_backups(&conn).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].root_id, None);
        assert_eq!(kept[0].root_path, "/Music");
        assert_eq!(kept[0].backup_name.as_deref(), Some("b-kept"));
    }

    #[test]
    fn a_reused_root_id_inherits_no_rows() {
        let state = state();
        let id = add_root(&state, "/Music");
        journal(&state.db.lock().unwrap(), id, "a");
        assert_eq!(removed(&state, id, true), Ok(()));

        let again = add_root(&state, "/Other");
        assert_eq!(again, id, "the highest root id is reused");
        assert!(journal_rows(&state.db.lock().unwrap(), again).unwrap().is_empty());
        assert_eq!(removed(&state, again, false), Ok(()));
    }

    #[test]
    fn pending_writes_name_the_files_by_absolute_path() {
        let state = state();
        let id = add_root(&state, "/Music");
        let other = add_root(&state, "/Other");
        {
            let conn = state.db.lock().unwrap();
            journal(&conn, id, "a");
            journal(&conn, other, "b");
        }
        let conn = state.db.lock().unwrap();
        let files = pending_paths(&conn, id).unwrap();
        let want = Path::new("/Music").join("a.opus").to_string_lossy().into_owned();
        assert_eq!(files, vec![want]);
        assert!(pending_paths(&conn, 999).unwrap().is_empty());
    }
}
