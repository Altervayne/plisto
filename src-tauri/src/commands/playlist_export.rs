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
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::{ExportPhase, ExportProgress, ExportSummary, PlaylistM3uSummary};
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

/// Exports `playlist_id` as an album-structured folder under `destination`: retagged copies laid out
/// like the library (each album and single the playlist touches, plus an Unsorted bag of its loose
/// tracks), the playlist's own `cover.jpg`, a `.nomedia`, and a bundled `.m3u8`, streaming progress
/// over `on_progress`. Rejects while another playlist folder export runs. Snapshots the plan, the
/// playlist cover and the roots under one lock, then releases it; validates the destination before any
/// write (refusing one inside the workspace or not writable); runs the worker on a blocking thread.
#[tauri::command]
pub async fn export_playlist_folder(
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
    let covers_dir = state.covers_dir.clone();
    let cancel = Arc::clone(&state.playlist_export_cancel);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        export::run_playlist_folder(&plan, &m3u, &cover, &destination, &covers_dir, &cancel, move |p| {
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
