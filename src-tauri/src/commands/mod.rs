/*
 * The IPC command surface for scanning and reading the index. scan_workspace runs the pipeline
 * on a blocking thread and awaits it, so the runtime stays free to service cancel_scan; a
 * running guard rejects a second concurrent scan. list_tracks reads through the shared read
 * connection, building its SQL through the pure allowlisted query builder.
 */

// -- Module Declarations --
mod list_query;

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

// -- Local Imports --
use crate::dto::{ListTracksResponse, ScanProgress, ScanSummary, SortSpec, TrackRow};
use crate::scan;
use crate::state::AppState;
use list_query::build_list_query;

/// Scans `path` into the index, streaming progress over `on_progress` and returning the summary.
/// Rejects while another scan is running. Resets the cancel flag at the start so a prior cancel
/// does not stop this run.
#[tauri::command]
pub async fn scan_workspace(
    path: String,
    on_progress: Channel<ScanProgress>,
    state: State<'_, AppState>,
) -> Result<ScanSummary, String> {
    if state.scan_running.swap(true, Ordering::SeqCst) {
        return Err("a scan is already running".to_string());
    }
    state.cancel.store(false, Ordering::SeqCst);

    let db_path = state.db_path.clone();
    let cancel = Arc::clone(&state.cancel);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(path);
        let scanned_at = now_unix();
        scan::run_scan(&root, &db_path, &cancel, scanned_at, move |p| {
            let _ = on_progress.send(p);
        })
    })
    .await;

    state.scan_running.store(false, Ordering::SeqCst);

    match outcome {
        Ok(result) => result,
        Err(_) => Err("scan task failed to run".to_string()),
    }
}

/// Signals a running scan to stop. The workers stop feeding, the writer commits what it has,
/// and the summary reports the run as cancelled.
#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/// Returns a window of indexed tracks plus the full count for the current filter. With no
/// offset and no limit it returns every matching row (the load-all path). An out-of-allowlist
/// sort column is rejected before any SQL runs.
#[tauri::command]
pub fn list_tracks(
    state: State<'_, AppState>,
    filter: Option<String>,
    sort: Option<SortSpec>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<ListTracksResponse, String> {
    let query = build_list_query(filter.as_deref(), sort.as_ref(), offset, limit)?;

    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;

    // A single LIKE term bound to ?1 when a filter is present; no params otherwise.
    let bind: Vec<String> = query.like_term.iter().cloned().collect();

    let total: u32 = conn
        .query_row(
            &query.count_sql,
            rusqlite::params_from_iter(bind.iter()),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(&query.rows_sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bind.iter()), row_from_sql)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<TrackRow>>>()
        .map_err(|e| e.to_string())?;

    Ok(ListTracksResponse { rows, total })
}

/// Maps one result row into a TrackRow. The column order matches the projection in the query
/// builder.
fn row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<TrackRow> {
    Ok(TrackRow {
        id: r.get(0)?,
        source_path: r.get(1)?,
        filename: r.get(2)?,
        ext: r.get(3)?,
        size_bytes: r.get(4)?,
        mtime: r.get(5)?,
        duration_secs: r.get(6)?,
        raw_title: r.get(7)?,
        raw_artist: r.get(8)?,
        raw_album: r.get(9)?,
        raw_album_artist: r.get(10)?,
        raw_track_no: r.get(11)?,
        raw_disc_no: r.get(12)?,
        raw_year: r.get(13)?,
        raw_genre: r.get(14)?,
        scanned_at: r.get(15)?,
    })
}

/// Current wall-clock time as whole seconds since the Unix epoch, stamped onto every row a scan
/// writes.
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
