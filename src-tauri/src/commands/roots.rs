/*
 * The IPC command surface for the library of roots: list the folders, add one (an overlap guard,
 * a row insert, then an incremental scan of just that folder), remove one (a cascade drop plus the
 * emptied-container cleanup), rescan one or all, and read a removal's blast radius. Every mutation
 * takes the app-level `scan_running` write lock before writing, so only one writer ever touches the
 * WAL at a time. The scanning commands mirror scan_workspace: reset the cancel flag, prep under a
 * brief lock, then run the walk on a blocking thread awaited so the runtime stays free to cancel.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::{Root, RootRemovalImpact, ScanProgress, ScanSummary};
use crate::normalize::normalize_path_key;
use crate::scan;
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
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".to_string());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let scanned_at = super::now_unix();

    // Reject an overlap and insert the root under the write lock, before the walk.
    let prepared = (|| -> Result<scan::ScanRoot, String> {
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
        })
    })();
    let root = match prepared {
        Ok(r) => r,
        Err(e) => {
            state.scan_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let result = run_scan_blocking(&state, vec![root], scanned_at, on_progress).await;
    state.scan_running.store(false, Ordering::SeqCst);
    result
}

/// Removes a root and everything under it, in one transaction: the cascade drops its tracks and
/// their album memberships, and any album or single left empty is deleted. Rejects while a scan
/// runs. No walk.
#[tauri::command]
pub fn remove_root(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".to_string());
    }
    let result = (|| -> Result<(), String> {
        let mut conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::remove_root(&mut conn, id).map_err(|e| e.to_string())
    })();
    state.scan_running.store(false, Ordering::SeqCst);
    result
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
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".to_string());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let scanned_at = super::now_unix();

    let prepared = (|| -> Result<Option<(i64, String)>, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::root_target(&conn, id).map_err(|e| e.to_string())
    })();
    let root = match prepared {
        Ok(Some((rid, path))) => scan::ScanRoot {
            id: rid,
            path: PathBuf::from(path),
        },
        Ok(None) => {
            state.scan_running.store(false, Ordering::SeqCst);
            return Err("no such folder".to_string());
        }
        Err(e) => {
            state.scan_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let result = run_scan_blocking(&state, vec![root], scanned_at, on_progress).await;
    state.scan_running.store(false, Ordering::SeqCst);
    result
}

/// Rescans every root, streaming progress over `on_progress`. The reconcile spans all roots (the
/// global sweep). Rejects while another scan runs.
#[tauri::command]
pub async fn rescan_all(
    on_progress: Channel<ScanProgress>,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".to_string());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let scanned_at = super::now_unix();

    let prepared = (|| -> Result<Vec<(i64, String)>, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::root_targets(&conn).map_err(|e| e.to_string())
    })();
    let targets = match prepared {
        Ok(t) => t,
        Err(e) => {
            state.scan_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let roots: Vec<scan::ScanRoot> = targets
        .into_iter()
        .map(|(id, path)| scan::ScanRoot {
            id,
            path: PathBuf::from(path),
        })
        .collect();

    let result = run_scan_blocking(&state, roots, scanned_at, on_progress).await;
    state.scan_running.store(false, Ordering::SeqCst);
    result
}

/// The blast radius of removing `id`, for the counted confirm: how many tracks the root holds, how
/// many albums shrink (built partly from it), and how many are deleted (built entirely from it).
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
    let (tracks, albums_losing_members, albums_emptied) =
        db::root_removal_impact(&conn, id).map_err(|e| e.to_string())?;
    Ok(RootRemovalImpact {
        tracks,
        albums_losing_members,
        albums_emptied,
    })
}

/// Runs the root-aware scan on a blocking thread and awaits it, so the runtime stays free to
/// service a cancel. The caller owns the `scan_running` guard; this only spawns the walk.
async fn run_scan_blocking(
    state: &State<'_, AppState>,
    roots: Vec<scan::ScanRoot>,
    scanned_at: i64,
    on_progress: Channel<ScanProgress>,
) -> Result<ScanSummary, String> {
    let db_path = state.db_path.clone();
    let cancel = Arc::clone(&state.cancel);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        scan::run_scan(&roots, &db_path, &cancel, scanned_at, move |p| {
            let _ = on_progress.send(p);
        })
    })
    .await;
    match outcome {
        Ok(result) => result,
        Err(_) => Err("scan task failed to run".to_string()),
    }
}
