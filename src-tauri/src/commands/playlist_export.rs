/*
 * The IPC command surface for playlist export, in three shapes. export_playlist_m3u writes an
 * in-place .m3u8 pointing at the original library files - instant, no progress channel, a brief lock
 * to snapshot the plan then a plain file write. export_playlist_rich_m3u8 writes that same in-place
 * playlist into its own folder beside a cover.jpg and a .nomedia, with Plisto's own directives on the
 * m3u8 so it can be re-imported - also instant and synchronous. export_playlist_folder writes an
 * album-structured folder of retagged copies with a bundled .m3u8, and mirrors export_library: a
 * running guard, a reset cancel flag, a snapshot under one lock, then a blocking worker awaited so
 * the runtime stays free to service cancel_playlist_export. All three keep the source folder read-only.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

// -- Local Imports --
use crate::commands::export::{civil_stamp, StagingGuard};
use crate::db;
use crate::dto::{DeviceTarget, ExportPhase, ExportProgress, ExportSummary, PlaylistM3uSummary};
use crate::export;
use crate::state::AppState;

/// Writes an in-place `.m3u8` for `playlist_id` at `path`, referencing the original library files by
/// their absolute paths. Snapshots the plan under a brief lock, releases it, renders the Extended
/// M3U and writes it. `path` gains a `.m3u8` extension when it has none; its parent folder must
/// exist. Missing-source slots are left out and counted. The source paths are written verbatim so
/// they resolve to the real files.
#[tauri::command]
pub fn export_playlist_m3u(
    playlist_id: i64,
    path: String,
    state: State<'_, AppState>,
) -> Result<PlaylistM3uSummary, String> {
    let plan = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        export::playlist_export_plan(&conn, playlist_id).map_err(|e| e.to_string())?
    };

    // A path without an extension gains `.m3u8`; one that already carries an extension is left as is.
    let mut out = PathBuf::from(path);
    if out.extension().is_none() {
        out.set_extension("m3u8");
    }
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err("the destination folder does not exist".to_string());
        }
    }

    let written = plan
        .tracks
        .iter()
        .filter(|t| t.missing_at.is_none())
        .count() as i64;
    let skipped_missing = plan.tracks.len() as i64 - written;

    let content = export::render_m3u(&plan, |t| t.source_path.clone());
    std::fs::write(&out, content)
        .map_err(|e| format!("could not write the playlist file: {e}"))?;

    Ok(PlaylistM3uSummary {
        written,
        skipped_missing,
    })
}

/// Exports `playlist_id` as an album-structured folder, either to a filesystem `destination` or
/// straight onto a connected `device`: retagged copies laid out like the library (each album and
/// single the playlist touches, plus an Unsorted bag of its loose tracks), the playlist's own
/// `cover.jpg`, a `.nomedia`, and a bundled `.m3u8`, streaming progress over `on_progress`.
/// `folder_pattern`/`file_pattern` lay out each member album (both empty falls to the shipped
/// default). Rejects while another playlist folder export runs. Snapshots the plan, the playlist
/// cover and the roots under one lock, then releases it. When `device` is `None` this validates the
/// destination and runs the worker on a blocking thread (the original folder path). When `device` is
/// `Some` it stages the same album tree to a temp folder and pushes it onto the phone, mirroring
/// `export_library`'s device branch (`device_in_place` merges into the picked device folder, else a
/// dated snapshot subfolder). The library source is only ever read; the temp staging is always cleaned.
#[tauri::command]
pub async fn export_playlist_folder(
    playlist_id: i64,
    destination: String,
    folder_pattern: Option<String>,
    file_pattern: Option<String>,
    device: Option<DeviceTarget>,
    device_in_place: bool,
    on_progress: Channel<ExportProgress>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ExportSummary, String> {
    if state.playlist_export_running.swap(true, Ordering::SeqCst) {
        return Err("a playlist export is already running".to_string());
    }
    state.playlist_export_cancel.store(false, Ordering::SeqCst);

    // The idle-to-running handoff: one Preparing tick while the plan is snapshotted and validated.
    let _ = on_progress.send(ExportProgress {
        phase: ExportPhase::Preparing,
        exported: 0,
        total: 0,
        errors: 0,
        done: false,
    });

    // Snapshot the structured plan, the play-order slots, the playlist cover and the roots under one
    // lock, then drop it. The worker owns all of it and never touches the DB again.
    let prepared = (|| -> Result<_, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let plan = export::playlist_folder_plan(&conn, playlist_id).map_err(|e| e.to_string())?;
        let m3u = export::playlist_export_plan(&conn, playlist_id).map_err(|e| e.to_string())?;
        let cover = export::playlist_cover_plan(&conn, playlist_id).map_err(|e| e.to_string())?;
        let roots = db::all_root_paths(&conn).map_err(|e| e.to_string())?;
        Ok((plan, m3u, cover, roots))
    })();
    let (plan, m3u, cover, roots) = match prepared {
        Ok(v) => v,
        Err(e) => {
            state.playlist_export_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let template = export::AlbumTemplate::resolve(
        &folder_pattern.unwrap_or_default(),
        &file_pattern.unwrap_or_default(),
    );
    let covers_dir = state.covers_dir.clone();
    let cancel = Arc::clone(&state.playlist_export_cancel);

    // A device target stages the album tree to a temp folder and pushes it onto the phone; the folder
    // path below is skipped. `destination` is ignored (a device has no filesystem path) and there is
    // nothing for check_destination to probe. This mirrors export_library's device branch, minus the
    // tray/status plumbing that command carries: this one only streams over on_progress, so emit_tick
    // is a bare channel send. (Only the album-folder shape gets a device path in D4 v1; a future
    // pass could reuse the same helper wiring for export_playlist_mimic_album.)
    if let Some(device) = device {
        let device_pidl = device.pidl;
        let in_place = device_in_place;

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
            cache_root.join(format!("plisto-playlist-export-{}-{}", std::process::id(), nanos));

        // D1: a fresh timestamped subfolder, so each transfer is a self-contained dated snapshot with
        // nothing to overwrite on the device. Sanitized to a safe component (drops the colons a clock
        // carries). The phone receives `<device folder>/Plisto <stamp>/<Albums|Singles|...>`.
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let stamp_folder =
            export::safe_component(&format!("Plisto {}", civil_stamp(secs)), "Plisto");

        // Trap B: the whole COM job runs on a dedicated STA std::thread under a ComApartment guard, so
        // apartment state can never leak onto a reused Tokio pool thread on an early return (the
        // device-unplugged path). The async command parks a blocking-pool thread on the join below,
        // staying free to service cancel_playlist_export.
        let spawned = std::thread::Builder::new()
            .name("plisto-playlist-mtp-export".to_string())
            .spawn(move || -> Result<ExportSummary, String> {
                // Declared before the apartment so it drops AFTER it: CoUninitialize runs first, the
                // temp cleanup second.
                let _staging = StagingGuard {
                    root: staging_root.clone(),
                };
                let _com = export::device::ComApartment::new();

                // In-place mode stages the buckets straight into the staging root, so the transfer
                // merges them into the device folder (updating a living library). Snapshot mode nests
                // them under a dated `Plisto <stamp>/` folder, so each run is self-contained. Either
                // way the transfer copies the staging root's top-level children onto the device, so
                // only this path differs.
                let stage_dir = if in_place {
                    staging_root.clone()
                } else {
                    staging_root.join(&stamp_folder)
                };
                std::fs::create_dir_all(&stage_dir)
                    .map_err(|_| "could not create the staging folder".to_string())?;

                // The emit sink: just the per-invocation channel (this command has no tray status or
                // app-global export events, unlike export_library).
                let emit_tick = |p: ExportProgress| {
                    let _ = on_progress.send(p);
                };

                // Staging: run_playlist_folder verbatim into the stage dir (COM-free). It writes the
                // album tree, the root cover.jpg, the .nomedia and the bundled .m3u8 there. Its own
                // terminal Done is rewritten to Copying/false - staging completion must never read as
                // the whole export's done, since the transfer is still to come.
                let summary = export::run_playlist_folder(
                    &plan,
                    &m3u,
                    &cover,
                    &stage_dir,
                    &covers_dir,
                    &template,
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
                // the folder path lets run_playlist_folder emit, sent here since staging's was suppressed.
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
                state.playlist_export_running.store(false, Ordering::SeqCst);
                return Err("could not start the device export".to_string());
            }
        };

        // Await the worker without blocking the async runtime: a blocking-pool thread parks on the
        // join while cancel_playlist_export stays serviceable.
        let joined = tauri::async_runtime::spawn_blocking(move || handle.join()).await;

        state.playlist_export_running.store(false, Ordering::SeqCst);

        return match joined {
            Ok(Ok(Ok(summary))) => Ok(summary),
            Ok(Ok(Err(message))) => Err(message),
            // The worker thread panicked, or the blocking join itself failed to run.
            Ok(Err(_)) | Err(_) => Err("playlist export task failed to run".to_string()),
        };
    }

    // Refuse a destination inside any root or one that is not writable, before any write.
    let check = export::check_destination(&destination, &roots);
    if check.inside_workspace {
        state.playlist_export_running.store(false, Ordering::SeqCst);
        return Err("the destination is inside a library folder".to_string());
    }
    if !check.writable {
        state.playlist_export_running.store(false, Ordering::SeqCst);
        return Err("the destination is not writable".to_string());
    }

    let destination = PathBuf::from(destination);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        export::run_playlist_folder(
            &plan,
            &m3u,
            &cover,
            &destination,
            &covers_dir,
            &template,
            &cancel,
            move |p| {
                let _ = on_progress.send(p);
            },
        )
    })
    .await;

    state.playlist_export_running.store(false, Ordering::SeqCst);

    match outcome {
        Ok(summary) => Ok(summary),
        Err(_) => Err("playlist export task failed to run".to_string()),
    }
}

/// Exports `playlist_id` as a standalone Mimic Album folder under `destination`: `destination` itself
/// becomes the album, its retagged copies numbered in playlist order, `album_artist` stamped `Various
/// Artists`, the embedded cover and a `cover.jpg`, so a folder-scanning phone reads the set as one
/// compilation. No bundled `.m3u`, no `.nomedia` - a mimic is an album to be scanned, not a playlist
/// bundle - so it runs run_export directly rather than run_playlist_folder. Rejects while another
/// playlist export runs. Snapshots the plan and the roots under one lock, then releases it; validates
/// the destination before any write (refusing one inside the workspace or not writable); runs the
/// worker on a blocking thread. A playlist with no slots writes nothing and reports zero.
#[tauri::command]
pub async fn export_playlist_mimic_album(
    playlist_id: i64,
    destination: String,
    on_progress: Channel<ExportProgress>,
    state: State<'_, AppState>,
) -> Result<ExportSummary, String> {
    if state.playlist_export_running.swap(true, Ordering::SeqCst) {
        return Err("a playlist export is already running".to_string());
    }
    state.playlist_export_cancel.store(false, Ordering::SeqCst);

    // The idle-to-running handoff: one Preparing tick while the plan is snapshotted and validated.
    let _ = on_progress.send(ExportProgress {
        phase: ExportPhase::Preparing,
        exported: 0,
        total: 0,
        errors: 0,
        done: false,
    });

    // Snapshot the flat mimic plan and the roots under one lock, then drop it. The worker owns it.
    let prepared = (|| -> Result<_, String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let plan = export::mimic_album_plan(&conn, playlist_id).map_err(|e| e.to_string())?;
        let roots = db::all_root_paths(&conn).map_err(|e| e.to_string())?;
        Ok((plan, roots))
    })();
    let (plan, roots) = match prepared {
        Ok(v) => v,
        Err(e) => {
            state.playlist_export_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    // Refuse a destination inside any root or one that is not writable, before any write.
    let check = export::check_destination(&destination, &roots);
    if check.inside_workspace {
        state.playlist_export_running.store(false, Ordering::SeqCst);
        return Err("the destination is inside a library folder".to_string());
    }
    if !check.writable {
        state.playlist_export_running.store(false, Ordering::SeqCst);
        return Err("the destination is not writable".to_string());
    }

    let destination = PathBuf::from(destination);
    // The container is flat, so the folder pattern never applies; the default file pattern numbers the
    // copies `NN - Title`, matching what a folder-scanning phone expects of an album.
    let template = export::AlbumTemplate::resolve("", "");
    let covers_dir = state.covers_dir.clone();
    let cancel = Arc::clone(&state.playlist_export_cancel);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        export::run_export(&plan, &destination, &template, &covers_dir, &cancel, move |p| {
            let _ = on_progress.send(p);
        })
    })
    .await;

    state.playlist_export_running.store(false, Ordering::SeqCst);

    match outcome {
        Ok(summary) => Ok(summary),
        Err(_) => Err("playlist export task failed to run".to_string()),
    }
}

/// Exports `playlist_id` as a rich `.m3u8` folder under `destination`: the playlist file referencing
/// the original library files in place, beside its `cover.jpg` and a `.nomedia`. The m3u8 carries
/// Plisto's own header directives (`#PLAYLIST`, `#DESCRIPTION`, `#EXTIMG`) so Plisto can re-import it;
/// other players ignore them. No copies, so this is near-instant and synchronous, mirroring
/// export_playlist_m3u. A playlist with no cover simply skips the cover.jpg and the `#EXTIMG` line.
#[tauri::command]
pub fn export_playlist_rich_m3u8(
    playlist_id: i64,
    destination: String,
    state: State<'_, AppState>,
) -> Result<PlaylistM3uSummary, String> {
    let (plan, description, cover) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let plan = export::playlist_export_plan(&conn, playlist_id).map_err(|e| e.to_string())?;
        let description = db::playlist_description(&conn, playlist_id).map_err(|e| e.to_string())?;
        let cover = export::playlist_cover_plan(&conn, playlist_id).map_err(|e| e.to_string())?;
        (plan, description, cover)
    };

    let dest = PathBuf::from(&destination);
    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("could not create the destination folder: {e}"))?;

    // The playlist's own cover beside the m3u8, re-encoded to JPEG. A missing cover skips both the
    // file and the #EXTIMG directive that would point at it.
    let cover_jpeg = export::cover_jpeg(&cover, &state.covers_dir);
    if let Some(bytes) = &cover_jpeg {
        std::fs::write(dest.join("cover.jpg"), bytes)
            .map_err(|e| format!("could not write the cover: {e}"))?;
    }
    // The empty .nomedia keeps the exported cover out of gallery scanners.
    let _ = std::fs::write(dest.join(".nomedia"), b"");

    let written = plan
        .tracks
        .iter()
        .filter(|t| t.missing_at.is_none())
        .count() as i64;
    let skipped_missing = plan.tracks.len() as i64 - written;

    let content = export::render_rich_m3u8(&plan, description.as_deref(), cover_jpeg.is_some());
    let stem = export::safe_component(plan.name.as_deref().unwrap_or("Playlist"), "Playlist");
    std::fs::write(dest.join(format!("{stem}.m3u8")), content)
        .map_err(|e| format!("could not write the playlist file: {e}"))?;

    Ok(PlaylistM3uSummary {
        written,
        skipped_missing,
    })
}

/// Signals a running playlist folder export to stop. The worker finishes the file it is on, skips
/// the rest, and reports the run as cancelled. Whatever landed stays valid; no bundled playlist is
/// written on a cancel.
#[tauri::command]
pub fn cancel_playlist_export(state: State<'_, AppState>) -> Result<(), String> {
    state.playlist_export_cancel.store(true, Ordering::SeqCst);
    Ok(())
}
