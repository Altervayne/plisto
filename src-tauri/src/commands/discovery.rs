/*
 * The IPC command surface for the covers workspace image sweep: stream every folder of loose images
 * across the library with its needs-cover reconciliation, and cancel a running sweep. Structured
 * like the scan commands - reset the cancel flag, snapshot the bindings under the read lock, then run
 * the walk on a blocking thread awaited so the runtime stays free to service a cancel. Its own
 * running/cancel flag pair keeps it independent of scan and export; it rejects while a scan runs,
 * since both walk the whole library. The sweep only reads: the music folders and the index are never
 * written.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

// -- Local Imports --
use crate::db;
use crate::discovery::{run_discovery, DiscoverySnapshot};
use crate::dto::ImageFolderGroup;
use crate::state::AppState;

/// Streams every folder of loose images across the library over `on_batch`, one group per folder,
/// each carrying its needs-cover reconciliation. Rejects while another sweep runs, and rejects while
/// a scan runs (both are full-library walks). Resets the cancel flag, snapshots the roots and cover
/// bindings under the read lock, then walks on a blocking thread. Read-only throughout.
#[tauri::command]
pub async fn discover_library_images(
    on_batch: Channel<ImageFolderGroup>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.discovery_running.swap(true, Ordering::SeqCst) {
        return Err("a discovery is already running".to_string());
    }
    // A scan and a sweep both read every root; only one at a time in v1.
    if state.scan_running.load(Ordering::SeqCst) {
        state.discovery_running.store(false, Ordering::SeqCst);
        return Err("a scan is running".to_string());
    }
    state.discovery_cancel.store(false, Ordering::SeqCst);

    // Snapshot the roots and the cover bindings under the read lock, before the walk, so the sweep
    // reconciles against one consistent view without holding the lock through the walk.
    let prepared = (|| -> Result<(Vec<PathBuf>, DiscoverySnapshot), String> {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let roots = db::root_targets(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(_, path)| PathBuf::from(path))
            .collect();
        let folder_covers = db::all_folder_cover_paths(&conn).map_err(|e| e.to_string())?;
        let states = db::load_folder_track_states(&conn).map_err(|e| e.to_string())?;
        let albums = db::load_albums(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|a| (a.id, a.title, a.cover_id.is_some()))
            .collect();
        Ok((roots, DiscoverySnapshot::build(folder_covers, states, albums)))
    })();
    let (roots, snapshot) = match prepared {
        Ok(v) => v,
        Err(e) => {
            state.discovery_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    let cancel = Arc::clone(&state.discovery_cancel);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_discovery(&roots, &snapshot, &cancel, move |group| {
            let _ = on_batch.send(group);
        })
    })
    .await;

    state.discovery_running.store(false, Ordering::SeqCst);

    match outcome {
        Ok(result) => result,
        Err(_) => Err("discovery task failed to run".to_string()),
    }
}

/// Signals a running discovery sweep to stop. The walk stops between entries and the summary of
/// groups sent so far stands; nothing is written.
#[tauri::command]
pub fn cancel_discovery(state: State<'_, AppState>) -> Result<(), String> {
    state.discovery_cancel.store(true, Ordering::SeqCst);
    Ok(())
}
