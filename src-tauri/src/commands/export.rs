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
use tauri::{AppHandle, Emitter, State};

// -- Local Imports --
use crate::db;
use crate::dto::{
    DestinationCheck, ExportConfig, ExportPhase, ExportProgress, ExportStatus, ExportSummary,
};
use crate::export;
use crate::state::AppState;

/// Exports the organized library to `config.destination`, streaming progress over `on_progress`
/// and returning the report. Rejects while another export runs. Snapshots the plan under a brief
/// lock, then releases it; validates the destination before any write (refusing one inside the
/// workspace or not writable); runs the worker on a blocking thread and awaits it. Alongside the
/// per-invocation channel it drives the app-global export events (`export:started`/`:progress`/
/// `:finished`/`:failed`) and the shared `export_status`, so the tray popup and the notification
/// listener follow the same run without touching the channel path the export view uses.
#[tauri::command]
pub async fn export_library(
    config: ExportConfig,
    on_progress: Channel<ExportProgress>,
    app: AppHandle,
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
        let plan = export::build_export_plan(&conn, &config)?;
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
    let template = export::AlbumTemplate::resolve(&config.folder_pattern, &config.file_pattern);
    let covers_dir = state.covers_dir.clone();
    let cancel = Arc::clone(&state.export_cancel);

    // The run begins here, past every validation, so a started event always pairs with a terminal
    // one. Mark the shared status running and announce it before the first copy.
    if let Ok(mut status) = state.export_status.lock() {
        *status = ExportStatus {
            running: true,
            progress: None,
        };
    }
    let _ = app.emit("export:started", ());

    let status = Arc::clone(&state.export_status);
    let worker_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        export::run_export(
            &plan,
            &destination,
            &template,
            &covers_dir,
            &cancel,
            move |p| {
                if let Ok(mut status) = status.lock() {
                    status.progress = Some(p.clone());
                }
                let _ = worker_app.emit("export:progress", &p);
                let _ = on_progress.send(p);
            },
        )
    })
    .await;

    state.export_running.store(false, Ordering::SeqCst);
    if let Ok(mut status) = state.export_status.lock() {
        *status = ExportStatus {
            running: false,
            progress: None,
        };
    }

    match outcome {
        Ok(summary) => {
            let _ = app.emit("export:finished", &summary);
            Ok(summary)
        }
        Err(_) => {
            let message = "export task failed to run".to_string();
            let _ = app.emit("export:failed", &message);
            Err(message)
        }
    }
}

/// The current app-global export snapshot, for the tray popup opening mid-run. Reads the shared
/// status the running export keeps live; idle otherwise.
#[tauri::command]
pub fn get_export_status(state: State<'_, AppState>) -> Result<ExportStatus, String> {
    let status = state
        .export_status
        .lock()
        .map_err(|_| "export status is unavailable".to_string())?;
    Ok(status.clone())
}

/// Signals a running export to stop. The worker finishes the file it is on, skips the rest, and
/// reports the run as cancelled. Whatever landed stays valid.
#[tauri::command]
pub fn cancel_export(state: State<'_, AppState>) -> Result<(), String> {
    state.export_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Renders a sample export path for the given album templates using the real derivation, so the UI
/// live-preview matches actual output (sanitization included). Runs over a synthetic sample album
/// track and returns the relative path with forward slashes. Pure: touches neither disk nor DB.
#[tauri::command]
pub fn export_template_preview(folder_pattern: String, file_pattern: String) -> String {
    export::template_preview(&folder_pattern, &file_pattern)
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
