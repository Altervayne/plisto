/*
 * The IPC commands that point the gone tracks under one folder of a root at the folder they moved to.
 * A preview stats each gone file at its place under the picked folder (exact path and indexed size)
 * and asks the writer what that would do; the apply repeats both under the scan lock, takes a restore
 * point and runs the writer. A refusal comes back as a value and changes nothing. The database mutex
 * is only held for the reads and the write, never across the stat.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::State;

// -- Local Imports --
use super::restore_points::point_before;
use crate::bootlog::BootLog;
use crate::db::{self, LocateFolderError, LocateFolderPlan, LocateTarget};
use crate::dto::{LocateFolderOutcome, LocateFolderPreview, LocateFolderRefusal};
use crate::relocate::check_files;
use crate::scan;
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

const INDEX_UNAVAILABLE: &str = "index is unavailable";

/// How long a preview may stat before it gives up; a moved folder on a slow drive can hold thousands
/// of files.
const PREVIEW_DEADLINE: Duration = Duration::from_secs(10);

/// What locating `folder` of `root_id` at `new_path` would do, without changing anything. Takes no scan
/// lock: the database is read under a brief mutex and the files are stat'ed on a blocking thread.
#[tauri::command]
pub async fn preview_locate_folder(
    root_id: i64,
    folder: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<LocateFolderPreview, String> {
    preview(&state, root_id, &folder, &new_path).await
}

/// Points the gone tracks under `folder` of `root_id` at `new_path`. The scan lock is held from the
/// re-check through the write, and the preview is never trusted: the files are stat'ed again with no
/// deadline, ending early if the user cancels. A refusal, including a failed write (which leaves the
/// library as it was), is returned as `Refused`. A scan is not needed: the stat proved each found file.
#[tauri::command]
pub async fn locate_folder(
    root_id: i64,
    folder: String,
    new_path: String,
    state: State<'_, AppState>,
    boot_log: State<'_, BootLog>,
) -> Result<LocateFolderOutcome, String> {
    apply(&state, root_id, &folder, &new_path, || {
        point_before(&state, &boot_log, "relocate")
    })
    .await
}

async fn preview(
    state: &AppState,
    root_id: i64,
    folder: &str,
    new_path: &str,
) -> Result<LocateFolderPreview, String> {
    let targets = match read_targets(state, root_id, folder, new_path)? {
        Ok(targets) => targets,
        Err(reason) => return Ok(LocateFolderPreview::Refused { reason }),
    };
    let found = match stat_blocking(targets, new_path, Some(PREVIEW_DEADLINE), None).await? {
        Ok(found) => found,
        Err(reason) => return Ok(LocateFolderPreview::Refused { reason }),
    };
    plan_preview(state, root_id, folder, new_path, &found)
}

async fn apply(
    state: &AppState,
    root_id: i64,
    folder: &str,
    new_path: &str,
    point: impl FnOnce() -> bool,
) -> Result<LocateFolderOutcome, String> {
    let _lock = acquire_scan_lock(state, Holder::User)?;
    state.cancel.store(false, Ordering::SeqCst);

    let targets = match read_targets(state, root_id, folder, new_path)? {
        Ok(targets) => targets,
        Err(reason) => return Ok(LocateFolderOutcome::Refused { reason }),
    };
    let cancel = Some(state.cancel.clone());
    let found = match stat_blocking(targets, new_path, None, cancel).await? {
        Ok(found) => found,
        Err(reason) => return Ok(LocateFolderOutcome::Refused { reason }),
    };
    write(state, root_id, folder, new_path, &found, point)
}

/// The gone files to look for under `new_path`, read under a brief lock. The outer error is a failure
/// to read, the inner one a refusal.
fn read_targets(
    state: &AppState,
    root_id: i64,
    folder: &str,
    new_path: &str,
) -> Result<Result<Vec<LocateTarget>, LocateFolderRefusal>, String> {
    let conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
    Ok(db::locate_targets(&conn, root_id, folder, new_path).map_err(|e| refusal_of(&e)))
}

/// The filesystem half: `new_path` must be readable, then every target is stat'ed. A check cut short
/// is a cancel when the flag is set, else a deadline.
fn stat_files(
    targets: &[LocateTarget],
    new_path: &str,
    deadline: Option<Instant>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> Result<HashMap<String, i64>, LocateFolderRefusal> {
    if !scan::root_reachable(Path::new(new_path)) {
        return Err(LocateFolderRefusal::Unreadable);
    }
    let check = check_files(targets, deadline, cancel);
    if !check.cut_short {
        return Ok(check.found);
    }
    if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
        Err(LocateFolderRefusal::Cancelled)
    } else {
        Err(LocateFolderRefusal::Inconclusive)
    }
}

/// Runs `stat_files` off the runtime. Takes no lock.
async fn stat_blocking(
    targets: Vec<LocateTarget>,
    new_path: &str,
    deadline: Option<Duration>,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Result<HashMap<String, i64>, LocateFolderRefusal>, String> {
    let new_path = new_path.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = deadline.map(|d| Instant::now() + d);
        stat_files(&targets, &new_path, deadline, cancel.as_deref())
    })
    .await
    .map_err(|_| "locate check failed to run".to_string())
}

/// What the writer would do given `found`, read under a brief lock.
fn plan_preview(
    state: &AppState,
    root_id: i64,
    folder: &str,
    new_path: &str,
    found: &HashMap<String, i64>,
) -> Result<LocateFolderPreview, String> {
    let conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
    Ok(
        match db::plan_locate_folder(&conn, root_id, folder, new_path, found) {
            Ok(plan) => ready(&plan),
            Err(e) => LocateFolderPreview::Refused {
                reason: refusal_of(&e),
            },
        },
    )
}

fn ready(plan: &LocateFolderPlan) -> LocateFolderPreview {
    let (relinked, merged, stays) = (
        plan.relinked.len() as i64,
        plan.merged.len() as i64,
        plan.stays.len() as i64,
    );
    LocateFolderPreview::Ready {
        target_root_id: plan.target_root_id,
        total: relinked + merged + stays,
        relinked,
        merged,
        stays,
        albums_replaced: plan.albums_replaced,
        partial: stays > 0,
    }
}

/// Plans and writes under one hold of the mutex, after `point` (its result is ignored: a locate
/// proceeds when no point could be saved). The writer plans again inside its transaction.
fn write(
    state: &AppState,
    root_id: i64,
    folder: &str,
    new_path: &str,
    found: &HashMap<String, i64>,
    point: impl FnOnce() -> bool,
) -> Result<LocateFolderOutcome, String> {
    let mut conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
    let plan = match db::plan_locate_folder(&conn, root_id, folder, new_path, found) {
        Ok(plan) => plan,
        Err(e) => {
            return Ok(LocateFolderOutcome::Refused {
                reason: refusal_of(&e),
            })
        }
    };
    point();
    Ok(match db::locate_folder(&mut conn, &plan, super::now_unix()) {
        Ok(report) => LocateFolderOutcome::Done {
            relinked: report.relinked,
            merged: report.merged,
            stays: report.stays,
            albums_replaced: report.albums_replaced,
        },
        Err(e) => LocateFolderOutcome::Refused {
            reason: refusal_of(&e),
        },
    })
}

// Exhaustive, so a new writer error has to be placed here.
fn refusal_of(error: &LocateFolderError) -> LocateFolderRefusal {
    match error {
        LocateFolderError::RootLevel => LocateFolderRefusal::RootLevel,
        LocateFolderError::NothingGone => LocateFolderRefusal::NothingGone,
        LocateFolderError::Same => LocateFolderRefusal::Same,
        LocateFolderError::Overlap => LocateFolderRefusal::Overlap,
        LocateFolderError::OutsideRoots => LocateFolderRefusal::OutsideRoots,
        LocateFolderError::NoMatch => LocateFolderRefusal::NoMatch,
        LocateFolderError::Sql(_)
        | LocateFolderError::RootGone
        | LocateFolderError::OutOfPrefix { .. } => LocateFolderRefusal::Failed {
            message: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests;
