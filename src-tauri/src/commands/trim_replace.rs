/*
 * The IPC command surface for trimming a library Opus file in place and undoing it. Each command
 * runs on a blocking thread under the file-write guard and the scan lock, checks its refusals in a
 * fixed order with the lock held, then hands the file to `file_writes::trim` on a connection of its
 * own. A refusal or failure rejects with the string `TrimFailure` displays; a held lock passes its
 * own busy string through. The track ids a re-read changed go out on `library:delta`, failures
 * included.
 */

// -- Library Imports --
use std::io;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::MutexGuard;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

// -- Local Imports --
use super::file_writes::{write_guard, WriteRefusal};
use super::restore_points::point_before;
use crate::bootlog::BootLog;
use crate::db::file_writes::{backup_days, undo_row, UndoRow};
use crate::dto::{LibraryDelta, SplicePhase, SpliceProgress, TrimReplaceJob, TrimReplaceResult};
use crate::file_writes::attrs::is_read_only;
use crate::file_writes::fault::Fault;
use crate::file_writes::in_use::in_use;
use crate::file_writes::space::free_space;
use crate::file_writes::trim::{
    open_write_conn, reread_file, trim_in_place, undo_trim, TrimFailure, TrimFile, WriteRun,
};
use crate::paths::relative_under;
use crate::scan::{file_stats_checked, root_reachable};
use crate::scan_lock::{acquire_scan_lock, Holder, WRITE_BUSY};
use crate::splice::Format;
use crate::state::AppState;

// Room the volume keeps past the copy itself, for the file system's own records.
const SPACE_SLACK: u64 = 1 << 20;

/// Trims the library track `job.track_id` to `job.segment` in place, keeping the original as a
/// hidden backup, and returns the undo it can take. Progress ticks Preparing, Cutting, then Done.
#[tauri::command]
pub async fn trim_replace(
    job: TrimReplaceJob,
    on_progress: Channel<SpliceProgress>,
    app: AppHandle,
) -> Result<TrimReplaceResult, String> {
    let worker = app.clone();
    let (result, changed) = tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        let boot_log = worker.state::<BootLog>();
        let mut changed = Vec::new();
        let result = replace_track(
            &state,
            &job,
            |tick| {
                let _ = on_progress.send(tick);
            },
            || {
                point_before(&state, &boot_log, "trim_replace");
            },
            Fault::NONE,
            &mut changed,
        );
        (result, changed)
    })
    .await
    .map_err(|_| "trim task failed to run".to_string())?;
    announce(&app, changed);
    result
}

/// Asks a running trim to stop. It is honoured until the swap; past it the trim finishes. With no
/// write running there is nothing to stop, and the ask is dropped.
#[tauri::command]
pub fn trim_replace_cancel(state: State<'_, AppState>) {
    cancel_write(&state);
}

// The flag is raised, then lowered again when no write runs, so a cancel never outlives its run: a
// run ending in between clears the flag after it was raised.
fn cancel_write(state: &AppState) {
    state.file_write_cancel.store(true, Ordering::SeqCst);
    if !state.file_write_running.load(Ordering::SeqCst) {
        state.file_write_cancel.store(false, Ordering::SeqCst);
    }
}

/// Puts back the original a trim kept, from the editor or from Kept backups.
#[tauri::command]
pub async fn trim_undo(undo_id: i64, app: AppHandle) -> Result<(), String> {
    let worker = app.clone();
    let (result, changed) = tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        let mut changed = Vec::new();
        let result = undo_track(&state, undo_id, Fault::NONE, &mut changed);
        (result, changed)
    })
    .await
    .map_err(|_| "trim task failed to run".to_string())?;
    announce(&app, changed);
    result
}

fn announce(app: &AppHandle, ids: Vec<i64>) {
    if !ids.is_empty() {
        let _ = app.emit("library:delta", &LibraryDelta::Ids { ids });
    }
}

fn tick(phase: SplicePhase, completed: u32, done: bool) -> SpliceProgress {
    SpliceProgress {
        phase,
        completed,
        total: 1,
        errors: 0,
        done,
    }
}

/// The trim behind `trim_replace`. `point` takes the restore point once the refusals pass; the ids
/// any re-read changed land in `changed`.
fn replace_track(
    state: &AppState,
    job: &TrimReplaceJob,
    mut progress: impl FnMut(SpliceProgress),
    point: impl FnOnce(),
    fault: Fault,
    changed: &mut Vec<i64>,
) -> Result<TrimReplaceResult, String> {
    let _run = write_guard(state, "trim").map_err(refusal)?;
    progress(tick(SplicePhase::Preparing, 0, false));
    let _lock = acquire_scan_lock(state, Holder::FileWrite)?;
    // The index is locked only to read it, so a share that stops answering during the file checks
    // holds no other command.
    let (track, keep_days) = {
        let conn = index(state)?;
        let track = trim_row(&conn, job).map_err(|why| why.to_string())?;
        (track, backup_days(&conn))
    };
    let file = check_trim(state, &track, changed).map_err(|why| why.to_string())?;
    let idle = index(state)?;
    point();
    drop(idle);
    let conn = open_write_conn(&state.db_path).map_err(|e| TrimFailure::of_db(&e).to_string())?;
    let mut run = WriteRun::new(&conn, fault, super::now_unix());
    progress(tick(SplicePhase::Cutting, 0, false));
    let cancelled = || state.file_write_cancel.load(Ordering::SeqCst);
    let done = trim_in_place(&mut run, &file, &job.segment, keep_days, &cancelled);
    state.note_write_recovery(std::mem::take(&mut run.left));
    let trimmed = done.map_err(|halt| halt.to_string())?;
    changed.extend(&trimmed.reread);
    progress(tick(SplicePhase::Done, 1, true));
    Ok(TrimReplaceResult {
        undo_id: trimmed.undo_id,
        backup_name: trimmed.backup_name,
        expires_at: trimmed.expires_at.map(|secs| secs * 1000),
    })
}

/// The undo behind `trim_undo`.
fn undo_track(
    state: &AppState,
    undo_id: i64,
    fault: Fault,
    changed: &mut Vec<i64>,
) -> Result<(), String> {
    let _run = write_guard(state, "trim").map_err(refusal)?;
    let _lock = acquire_scan_lock(state, Holder::FileWrite)?;
    let (undo, track) = {
        let conn = index(state)?;
        undo_target(&conn, undo_id).map_err(|why| why.to_string())?
    };
    let file = check_undo(state, &undo, &track).map_err(|why| why.to_string())?;
    let conn = open_write_conn(&state.db_path).map_err(|e| TrimFailure::of_db(&e).to_string())?;
    let mut run = WriteRun::new(&conn, fault, super::now_unix());
    let done = undo_trim(&mut run, &file, &undo);
    state.note_write_recovery(std::mem::take(&mut run.left));
    changed.extend(done.map_err(|halt| halt.to_string())?);
    Ok(())
}

fn refusal(why: WriteRefusal) -> String {
    match why {
        WriteRefusal::Off => TrimFailure::Unavailable("trim in place is off").to_string(),
        WriteRefusal::Running => WRITE_BUSY.to_string(),
        WriteRefusal::ExportRunning => TrimFailure::Busy("an export is running").to_string(),
    }
}

pub(super) fn index(state: &AppState) -> Result<MutexGuard<'_, Connection>, String> {
    state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())
}

// The trim's refusals from the index, in order: not a library track, not Opus, and a library row
// that moved on since the analysis.
fn trim_row(conn: &Connection, job: &TrimReplaceJob) -> Result<LibraryTrack, TrimFailure> {
    let track = library_track(conn, job.track_id)?
        .ok_or(TrimFailure::Unavailable("not a library track"))?;
    if Format::from_source(&track.path) != Some(Format::Opus) {
        return Err(TrimFailure::Unavailable("not an Opus file"));
    }
    if (track.size, track.mtime) != (job.expect.size_bytes, job.expect.mtime) {
        return Err(TrimFailure::Changed);
    }
    Ok(track)
}

// The trim's refusals from the disk, in order: missing, offline, a file that differs from its row,
// in use, read-only, and too little space for the cut beside the original. A file that differs from
// its row is read back first, so the editor's next analysis expects what is on disk.
fn check_trim(
    state: &AppState,
    track: &LibraryTrack,
    changed: &mut Vec<i64>,
) -> Result<TrimFile, TrimFailure> {
    let file = locate(track)?;
    if (file.size, file.mtime) != (track.size, track.mtime) {
        if let Ok(conn) = state.db.lock() {
            let now = super::now_unix();
            changed.extend(reread_file(&conn, &file.source, file.root_id, now));
        }
        return Err(TrimFailure::Changed);
    }
    check_writable(state, &file, file.size)?;
    Ok(file)
}

// The undo's refusals from the index: no kept backup to put back, or no library track.
fn undo_target(conn: &Connection, undo_id: i64) -> Result<(UndoRow, LibraryTrack), TrimFailure> {
    let undo = undo_row(conn, undo_id)
        .map_err(|e| TrimFailure::of_db(&e))?
        .filter(|u| u.kind == "trim" && u.undone_at.is_none() && u.backup_size.is_some())
        .filter(|u| {
            u.backup_name
                .as_deref()
                .is_some_and(|n| !n.contains(['\\', '/']))
        })
        .ok_or(TrimFailure::Unavailable("no kept backup to put back"))?;
    let track = match undo.track_id {
        Some(id) => library_track(conn, id)?,
        None => None,
    }
    .ok_or(TrimFailure::Unavailable("not a library track"))?;
    Ok((undo, track))
}

// The undo's refusals from the disk, in order: missing, offline, the backup gone, a file that is no
// longer the trimmed one, in use, read-only, and too little space for the copy of the backup.
fn check_undo(
    state: &AppState,
    undo: &UndoRow,
    track: &LibraryTrack,
) -> Result<TrimFile, TrimFailure> {
    let file = locate(track)?;
    let kept = file
        .source
        .with_file_name(undo.backup_name.as_deref().unwrap_or_default());
    if !kept.is_file() {
        return Err(TrimFailure::Missing);
    }
    if (file.size, file.mtime) != (undo.post_size, undo.post_mtime) {
        return Err(TrimFailure::Changed);
    }
    check_writable(state, &file, undo.backup_size.unwrap_or_default())?;
    Ok(file)
}

/// A track row with its root, as the refusals read it.
struct LibraryTrack {
    id: i64,
    root_id: i64,
    root: PathBuf,
    path: PathBuf,
    size: i64,
    mtime: i64,
    duration_secs: Option<f64>,
    missing: bool,
    title: String,
}

fn library_track(conn: &Connection, track_id: i64) -> Result<Option<LibraryTrack>, TrimFailure> {
    conn.query_row(
        "SELECT t.root_id, r.path, COALESCE(t.display_path, t.source_path), t.size_bytes, t.mtime,
                t.duration_secs, t.missing_at IS NOT NULL,
                COALESCE(te.title, t.raw_title, t.filename)
         FROM tracks t
         JOIN roots r ON r.id = t.root_id
         LEFT JOIN track_edits te ON te.track_id = t.id
         WHERE t.id = ?1",
        params![track_id],
        |r| {
            Ok(LibraryTrack {
                id: track_id,
                root_id: r.get(0)?,
                root: PathBuf::from(r.get::<_, String>(1)?),
                path: PathBuf::from(r.get::<_, String>(2)?),
                size: r.get(3)?,
                mtime: r.get(4)?,
                duration_secs: r.get(5)?,
                missing: r.get(6)?,
                title: r.get(7)?,
            })
        },
    )
    .optional()
    .map_err(|e| TrimFailure::of_db(&e))
}

// The track's file as it is on disk: refused when the scan flagged it gone, when its folder does
// not answer, or when the file is not there.
fn locate(track: &LibraryTrack) -> Result<TrimFile, TrimFailure> {
    if track.missing {
        return Err(TrimFailure::Missing);
    }
    if !root_reachable(&track.root) {
        return Err(TrimFailure::Offline);
    }
    let rel_path = relative_under(&track.path, &track.root)
        .and_then(|rel| rel.to_str().map(str::to_string))
        .filter(|rel| !rel.is_empty())
        .ok_or(TrimFailure::Unavailable(
            "the file is not in its library folder",
        ))?;
    let source = track.root.join(&rel_path);
    let (size, mtime) = file_stats_checked(&source).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => TrimFailure::Missing,
        _ => TrimFailure::of_io(&e),
    })?;
    Ok(TrimFile {
        track_id: track.id,
        root_id: track.root_id,
        root: track.root.clone(),
        rel_path,
        source,
        title: track.title.clone(),
        size,
        mtime,
        duration_ms: track
            .duration_secs
            .map(|secs| (secs * 1000.0).round() as i64),
    })
}

// In use, read-only, then free space for a copy of `copy_bytes` beside the file.
fn check_writable(state: &AppState, file: &TrimFile, copy_bytes: i64) -> Result<(), TrimFailure> {
    if sounding(state, file.track_id) {
        return Err(TrimFailure::InUse);
    }
    if is_read_only(&file.source).map_err(|e| TrimFailure::of_io(&e))? {
        return Err(TrimFailure::Denied);
    }
    let dir = file.source.parent().unwrap_or(&file.root);
    let free = free_space(dir).map_err(|e| TrimFailure::of_io(&e))?;
    if free < copy_bytes.max(0) as u64 + SPACE_SLACK {
        return Err(TrimFailure::Space);
    }
    Ok(())
}

// Whether the player holds the track open to sound it now or next. While nothing plays, the track
// the cursor rests on, paused there or with its seat cleared by a stopped preview, is the one the
// editor has open, and the swap leaves a paused handle reading the original. A playing preview of
// it is refused like playback.
fn sounding(state: &AppState, track_id: i64) -> bool {
    let status = state
        .player_status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let queue = state.player_queue.lock().unwrap_or_else(|e| e.into_inner());
    let ids = in_use(&status, &queue);
    match ids.first() {
        Some(&current) if current == track_id => status.playing,
        _ => ids.contains(&track_id),
    }
}

#[cfg(test)]
mod tests;
