/*
 * The IPC command surface for export. export_library mirrors scan_workspace: a running guard, a
 * reset cancel flag, a brief DB snapshot, then a blocking worker awaited so the runtime stays free
 * to service a cancel. The snapshot and the workspace-root read happen under one lock, which is
 * then dropped - the worker is DB-free. validate_export_destination is the up-front pre-check the
 * idle screen gates and warns on; cancel_export signals a running export to stop.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::{DestinationCheck, ExportConfig, ExportPhase, ExportProgress, ExportSummary};
use crate::export;
use crate::state::AppState;

/// Exports the organized library to `config.destination`, streaming progress over `on_progress`
/// and returning the report. Rejects while another export runs. Snapshots the plan under a brief
/// lock, then releases it; validates the destination before any write (refusing one inside the
/// workspace or not writable); runs the worker on a blocking thread and awaits it.
#[tauri::command]
pub async fn export_library(
    config: ExportConfig,
    on_progress: Channel<ExportProgress>,
    state: State<'_, AppState>,
) -> Result<ExportSummary, String> {
    if state.export_running.swap(true, Ordering::SeqCst) {
        return Err("an export is already running".to_string());
    }
    state.export_cancel.store(false, Ordering::SeqCst);

    // The idle-to-running handoff: one Preparing tick while the plan is snapshotted and validated.
    let _ = on_progress.send(ExportProgress {
        phase: ExportPhase::Preparing,
        exported: 0,
        total: 0,
        errors: 0,
        done: false,
    });

    // Snapshot the plan and read every root path under one lock, then drop it.
    let prepared = (|| -> Result<_, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let plan = export::build_plan(&conn).map_err(|e| e.to_string())?;
        let roots = db::all_root_paths(&conn).map_err(|e| e.to_string())?;
        Ok((plan, roots))
    })();
    let (plan, roots) = match prepared {
        Ok(v) => v,
        Err(e) => {
            state.export_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    // Refuse a destination inside any root or one that is not writable, before any write.
    let check = export::check_destination(&config.destination, &roots);
    if check.inside_workspace {
        state.export_running.store(false, Ordering::SeqCst);
        return Err("the destination is inside a library folder".to_string());
    }
    if !check.writable {
        state.export_running.store(false, Ordering::SeqCst);
        return Err("the destination is not writable".to_string());
    }

    let destination = PathBuf::from(config.destination);
    let covers_dir = state.covers_dir.clone();
    let cancel = Arc::clone(&state.export_cancel);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        export::run_export(&plan, &destination, &covers_dir, &cancel, move |p| {
            let _ = on_progress.send(p);
        })
    })
    .await;

    state.export_running.store(false, Ordering::SeqCst);

    match outcome {
        Ok(summary) => Ok(summary),
        Err(_) => Err("export task failed to run".to_string()),
    }
}

/// Signals a running export to stop. The worker finishes the file it is on, skips the rest, and
/// reports the run as cancelled. Whatever landed stays valid.
#[tauri::command]
pub fn cancel_export(state: State<'_, AppState>) -> Result<(), String> {
    state.export_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Inspects a picked destination before a run so the UI can gate and warn: whether it overlaps any
/// library root (a hard refusal), already holds files (a soft warn), and is writable. Never writes
/// inside a root.
#[tauri::command]
pub fn validate_export_destination(
    destination: String,
    state: State<'_, AppState>,
) -> Result<DestinationCheck, String> {
    let roots = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::all_root_paths(&conn).map_err(|e| e.to_string())?
    };
    Ok(export::check_destination(&destination, &roots))
}
