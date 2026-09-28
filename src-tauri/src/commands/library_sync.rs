/*
 * The IPC command surface for the background library sync: queue a manual rescan and read the sync
 * snapshot. Both only talk to the sync thread's channel or its snapshot; the passes themselves, their
 * progress and their results arrive as `library:*` events.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::State;

// -- Local Imports --
use crate::dto::LibrarySyncStatus;
use crate::library_sync::SyncCmd;
use crate::state::AppState;

/// Queues a full pass of one root, or of every root when `root_id` is None, and returns at once. It
/// joins the running session when there is one. Works whether or not keep-up-to-date is on.
#[tauri::command]
pub fn rescan_library(root_id: Option<i64>, state: State<'_, AppState>) -> Result<(), String> {
    state
        .library_sync
        .send(SyncCmd::Request(root_id))
        .map_err(|_| "library sync is unavailable".to_string())
}

/// The sync snapshot: whether keep-up-to-date is on, the running session's progress, and each root's
/// watch mode.
#[tauri::command]
pub fn get_library_sync_status(state: State<'_, AppState>) -> LibrarySyncStatus {
    let mut status = state
        .library_sync_status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    status.enabled = state.keep_library_up_to_date.load(Ordering::Relaxed);
    status
}
