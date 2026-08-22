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
    DestinationCheck, DeviceTarget, ExportConfig, ExportPhase, ExportProgress, ExportStatus,
    ExportSummary,
};
use crate::export;
use crate::state::AppState;

/// Opens the device-capable shell folder picker and returns the picked MTP target (or None on cancel).
/// The shell dialog is an STA object that must run on the main UI thread, so this hops there via
/// `run_on_main_thread` (Trap A) and waits on a channel for the result. Windows-only; other platforms
/// return an error from the resolver. This is the 1.6.0 device-export picker; the transfer is P2.
#[tauri::command]
pub fn pick_device_folder(app: AppHandle) -> Result<Option<DeviceTarget>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(export::device::pick_device_folder());
    })
    .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|_| "the device picker did not respond".to_string())?
}

/// Validates a picked device target before a run: re-resolves its PIDL to prove the device is still
/// connected. A device is never inside the workspace and needs no probe-write (MTP storages are
/// writable; a truly blocked target surfaces as a transfer error), so `writable`/`ok` track reachability
/// and `non_empty` stays false (we do not enumerate the device — scope guard). Runs the COM re-resolve on
/// the STA main thread, matching the picker. Windows-only in effect; elsewhere the resolver reports false.
#[tauri::command]
pub fn check_device(app: AppHandle, pidl: String) -> Result<DestinationCheck, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let ok = export::device::device_reachable(&pidl);
        let _ = tx.send(DestinationCheck {
            ok,
            inside_workspace: false,
            non_empty: false,
            writable: ok,
        });
    })
    .map_err(|e| e.to_string())?;
    rx.recv()
        .map_err(|_| "the device check did not respond".to_string())
}

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
        // The playlist-file shape writes a portable .m3u8 per playlist after the copies land; snapshot
        // each playlist's play-order slots here, under the same lock, so the worker stays DB-free.
        let mut playlist_files = Vec::new();
        if config.include_playlists && config.playlist_shape == "file" {
            for p in db::load_playlists(&conn).map_err(|e| e.to_string())?.playlists {
                playlist_files
                    .push(export::playlist_export_plan(&conn, p.id).map_err(|e| e.to_string())?);
            }
        }
        Ok((plan, roots, playlist_files))
    })();
    let (plan, roots, playlist_files) = match prepared {
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
        let summary = export::run_export(
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
        );
        // The portable playlist files land after the copies, only on a run that finished, so a
        // cancelled export never leaves an .m3u8 pointing at copies it never wrote. Empty for every
        // other shape, where the loop is a no-op.
        if !summary.cancelled {
            export::write_general_playlist_m3us(&plan, &playlist_files, &destination, &template);
        }
        summary
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
