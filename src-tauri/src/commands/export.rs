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
use tauri::{AppHandle, Emitter, Manager, State};

// -- Local Imports --
use crate::db;
use crate::dto::{
    DestinationCheck, DeviceTarget, ExportConfig, ExportPhase, ExportProgress, ExportStatus,
    ExportSummary,
};
use crate::export;
use crate::state::AppState;

/// A temp staging directory removed on drop, so the staged export never leaks whether the transfer
/// succeeds, fails, or the worker panics. Mirrors the `TempDir` Drop pattern in `export/mod.rs`'s
/// tests. Held on the device-export worker thread for the whole staging+transfer job.
struct StagingGuard {
    root: PathBuf,
}

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Formats a UTC calendar stamp `YYYY-MM-DD HH-MM-SS` from a Unix-seconds value, using dashes where a
/// clock would use colons so the result is a safe folder component with no further escaping. Pure and
/// deterministic (the clock is the injected `secs`), so the timestamped export subfolder is testable
/// without a real clock. The civil-date arithmetic is Howard Hinnant's days-to-date algorithm.
fn civil_stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);

    // Shift the epoch to 0000-03-01 so leap days fall at the end of the 400-year era, then unwind.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // day-of-era, [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // year-of-era, [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // day-of-year (Mar-based), [0, 365]
    let mp = (5 * doy + 2) / 153; // month, Mar=0 .. Feb=11
    let d = doy - (153 * mp + 2) / 5 + 1; // day-of-month, [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // to [1, 12]
    let y = y + if m <= 2 { 1 } else { 0 }; // Jan/Feb belong to the next civil year

    format!("{y:04}-{m:02}-{d:02} {h:02}-{mi:02}-{s:02}")
}

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

    // A device target stages the library to a temp folder and pushes it onto the phone; the whole
    // folder path below is skipped. `destination` is ignored (a device has no filesystem path) and
    // there is nothing for check_destination to probe. Everything the worker needs is snapshotted
    // here, so the dedicated STA thread stays free of managed state.
    if let Some(device) = config.device.clone() {
        let template = export::AlbumTemplate::resolve(&config.folder_pattern, &config.file_pattern);
        let covers_dir = state.covers_dir.clone();
        let cancel = Arc::clone(&state.export_cancel);
        let status = Arc::clone(&state.export_status);
        let in_place = config.device_in_place;

        // The staging root under the app cache dir (temp fallback), uniquely named so two runs never
        // collide. Its guard removes it on success, failure, and panic.
        let cache_root = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let staging_root =
            cache_root.join(format!("plisto-export-{}-{}", std::process::id(), nanos));

        // D1: a fresh timestamped subfolder, so each transfer is a self-contained dated snapshot with
        // nothing to overwrite on the device. Sanitized to a safe component (drops the colons a clock
        // carries). The phone receives `<device folder>/Plisto <stamp>/<Albums|Singles|...>`.
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let stamp_folder =
            export::safe_component(&format!("Plisto {}", civil_stamp(secs)), "Plisto");

        // Past every validation: mark the shared status running and announce it, exactly as the
        // folder path does, so a started event always pairs with a terminal one.
        if let Ok(mut s) = state.export_status.lock() {
            *s = ExportStatus {
                running: true,
                progress: None,
            };
        }
        let _ = app.emit("export:started", ());

        let worker_app = app.clone();
        let device_pidl = device.pidl;

        // Trap B: the whole COM job runs on a dedicated STA std::thread under a ComApartment guard, so
        // apartment state can never leak onto a reused Tokio pool thread on an early return (the
        // device-unplugged path). The async command parks a blocking-pool thread on the join below,
        // staying free to service cancel_export.
        let spawned = std::thread::Builder::new()
            .name("plisto-mtp-export".to_string())
            .spawn(move || -> Result<ExportSummary, String> {
                // Declared before the apartment so it drops AFTER it: CoUninitialize runs first, the
                // temp cleanup second.
                let _staging = StagingGuard {
                    root: staging_root.clone(),
                };
                let _com = export::device::ComApartment::new();

                // In-place mode stages the buckets straight into the staging root, so the transfer
                // merges them into the device folder (updating a living library, overwriting what
                // changed). Snapshot mode nests them under a dated `Plisto <stamp>/` folder, so each run
                // is self-contained. Either way the transfer copies the staging root's top-level
                // children onto the device, so only this path differs.
                let stage_dir = if in_place {
                    staging_root.clone()
                } else {
                    staging_root.join(&stamp_folder)
                };
                std::fs::create_dir_all(&stage_dir)
                    .map_err(|_| "could not create the staging folder".to_string())?;

                // The shared emit sink: the app-global status snapshot, the app-global progress event,
                // and the per-invocation channel, driven identically for staging and transfer ticks.
                let emit_tick = |p: ExportProgress| {
                    if let Ok(mut s) = status.lock() {
                        s.progress = Some(p.clone());
                    }
                    let _ = worker_app.emit("export:progress", &p);
                    let _ = on_progress.send(p);
                };

                // Staging: run_export verbatim into the timestamped subfolder (COM-free). Its own
                // terminal Done is rewritten to Copying/false - staging completion must never read as
                // the whole export's done, since the transfer is still to come (Holes 2 & 3, §4).
                let summary = export::run_export(
                    &plan,
                    &stage_dir,
                    &template,
                    &covers_dir,
                    &cancel,
                    |p| {
                        let p = if p.done {
                            ExportProgress {
                                phase: ExportPhase::Copying,
                                done: false,
                                ..p
                            }
                        } else {
                            p
                        };
                        emit_tick(p);
                    },
                );

                let final_summary = if summary.cancelled {
                    // A cancel during staging never reaches the device; the guard cleans the temp.
                    summary
                } else {
                    // Parity with the folder path: the portable playlist .m3u8s land in the staging
                    // tree so they transfer beside the copies they reference (their relative paths
                    // resolve on the device). Off the cancel path, like the folder export.
                    export::write_general_playlist_m3us(
                        &plan,
                        &playlist_files,
                        &stage_dir,
                        &template,
                    );

                    // The transfer: push the staged tree onto the device, streaming Transferring
                    // ticks. A hard error (disconnect / failure) bubbles as Err - no terminal Done,
                    // the UI drops to idle - while a mid-transfer cancel returns a cancelled outcome.
                    let outcome = export::device::transfer_to_device(
                        &staging_root,
                        &device_pidl,
                        &cancel,
                        |p| emit_tick(p),
                    )?;
                    ExportSummary {
                        cancelled: outcome.cancelled,
                        ..summary
                    }
                };

                // The single real terminal Done, for both a completed and a cancelled run - the tick
                // the folder path lets run_export emit, sent here since staging's was suppressed.
                emit_tick(ExportProgress {
                    phase: ExportPhase::Done,
                    exported: final_summary.exported,
                    total: final_summary.total,
                    errors: final_summary.errors,
                    done: true,
                });
                Ok(final_summary)
                // _com drops here (CoUninitialize), then _staging (the temp is removed).
            });

        let handle = match spawned {
            Ok(h) => h,
            Err(_) => {
                state.export_running.store(false, Ordering::SeqCst);
                if let Ok(mut s) = state.export_status.lock() {
                    *s = ExportStatus {
                        running: false,
                        progress: None,
                    };
                }
                let message = "could not start the device export".to_string();
                let _ = app.emit("export:failed", &message);
                return Err(message);
            }
        };

        // Await the worker without blocking the async runtime: a blocking-pool thread parks on the
        // join while cancel_export stays serviceable.
        let joined = tauri::async_runtime::spawn_blocking(move || handle.join()).await;

        state.export_running.store(false, Ordering::SeqCst);
        if let Ok(mut s) = state.export_status.lock() {
            *s = ExportStatus {
                running: false,
                progress: None,
            };
        }

        return match joined {
            Ok(Ok(Ok(summary))) => {
                let _ = app.emit("export:finished", &summary);
                Ok(summary)
            }
            Ok(Ok(Err(message))) => {
                let _ = app.emit("export:failed", &message);
                Err(message)
            }
            // The worker thread panicked, or the blocking join itself failed to run.
            Ok(Err(_)) | Err(_) => {
                let message = "export task failed to run".to_string();
                let _ = app.emit("export:failed", &message);
                Err(message)
            }
        };
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_stamp_formats_the_unix_epoch() {
        assert_eq!(civil_stamp(0), "1970-01-01 00-00-00");
    }

    #[test]
    fn civil_stamp_formats_a_known_instant() {
        // 1_700_000_000 is 2023-11-14T22:13:20Z.
        assert_eq!(civil_stamp(1_700_000_000), "2023-11-14 22-13-20");
    }

    #[test]
    fn civil_stamp_carries_no_colon_so_the_folder_component_is_safe() {
        // The stamp feeds a folder name, so it must never carry a path-illegal character. The dashes
        // stand in for a clock's colons; safe_component would strip them, but the stamp avoids them.
        let stamp = civil_stamp(1_700_000_000);
        assert!(!stamp.contains(':'), "the stamp must be colon-free: {stamp}");
        assert_eq!(
            export::safe_component(&format!("Plisto {stamp}"), "Plisto"),
            "Plisto 2023-11-14 22-13-20",
            "the timestamped folder survives sanitization unchanged",
        );
    }

    #[test]
    fn civil_stamp_handles_a_leap_day() {
        // 1_582_934_400 is 2020-02-29T00:00:00Z - the algorithm must place the leap day correctly.
        assert_eq!(civil_stamp(1_582_934_400), "2020-02-29 00-00-00");
    }
}
