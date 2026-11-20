/*
 * The IPC command surface for the Kept backups sheet: the list is a read and takes no lock; a
 * discard takes the user lock and refuses while a file write runs. Discarding is not gated on the
 * trim switch: it deletes Plisto's own hidden copy, not a music file.
 */

// -- Library Imports --
use tauri::{AppHandle, Manager};

// -- Local Imports --
use super::file_writes::refuse_while_writing;
use super::trim_replace::index;
use crate::db;
use crate::dto::{KeptBackup, KeptDiscardAllOutcome, KeptDiscardOutcome};
use crate::file_writes::backups::{describe, discard, discard_all, kept_places};
use crate::file_writes::recover::reach_check;
use crate::file_writes::trim::{open_write_conn, TrimFailure};
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

/// Every kept backup with where it stands. The index is held only to read the rows; the file
/// checks run after it is released.
#[tauri::command]
pub async fn kept_backups_list(app: AppHandle) -> Result<Vec<KeptBackup>, String> {
    run_blocking(app, list).await
}

/// Deletes one kept backup. Refused with `offline` when its folder does not answer; a file changed
/// since it was kept is left in place and its entry removed.
#[tauri::command]
pub async fn kept_backup_discard(
    undo_id: i64,
    app: AppHandle,
) -> Result<KeptDiscardOutcome, String> {
    run_blocking(app, move |state| discard_one(state, undo_id)).await
}

/// Deletes every kept backup it can reach; rows on an offline folder are skipped and counted.
#[tauri::command]
pub async fn kept_backups_discard_all(app: AppHandle) -> Result<KeptDiscardAllOutcome, String> {
    run_blocking(app, discard_every).await
}

async fn run_blocking<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&AppState) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || work(&app.state::<AppState>()))
        .await
        .map_err(|_| "kept backups task failed to run".to_string())?
}

fn list(state: &AppState) -> Result<Vec<KeptBackup>, String> {
    let (rows, trim_on) = {
        let conn = index(state)?;
        let rows = kept_places(&conn).map_err(|e| e.to_string())?;
        let on = db::get_setting(&conn, "trimReplace")
            .ok()
            .flatten()
            .as_deref()
            == Some("1");
        (rows, on)
    };
    Ok(describe(rows, trim_on, reach_check()))
}

// The user lock and the write check come first, as for every command that touches kept files; the
// work then runs on a connection of its own, so the shared index is free during the file checks.
fn discard_one(state: &AppState, undo_id: i64) -> Result<KeptDiscardOutcome, String> {
    let _lock = acquire_scan_lock(state, Holder::User)?;
    refuse_while_writing(state)?;
    let conn = open_write_conn(&state.db_path).map_err(|e| TrimFailure::of_db(&e).to_string())?;
    let left_in_place = discard(&conn, undo_id, reach_check())?;
    Ok(KeptDiscardOutcome { left_in_place })
}

fn discard_every(state: &AppState) -> Result<KeptDiscardAllOutcome, String> {
    let _lock = acquire_scan_lock(state, Holder::User)?;
    refuse_while_writing(state)?;
    let conn = open_write_conn(&state.db_path).map_err(|e| TrimFailure::of_db(&e).to_string())?;
    discard_all(&conn, reach_check()).map_err(|e| TrimFailure::of_db(&e).to_string())
}

#[cfg(test)]
mod tests;
