/*
 * The IPC command surface for playlists: create, rename and delete a playlist, set its description
 * and cover, append tracks as new slots, remove slots by their synthetic id, and reorder. The cover
 * reuses the album cover pipeline: decode and cache off the runtime thread, then write the manifest
 * row and the binding together, exactly as set_album_cover does. A playlist is the one multi-membership
 * container - the same track may sit in it more than once - so every membership op keys on the slot
 * id, not the track_id. Every write takes the shared read connection's Mutex, the same single writer
 * the album and cover commands use, and each multi-statement command runs in one transaction.
 * load_playlists is the load-all snapshot the frontend hydrates its playlist state from.
 */

// -- Library Imports --
use std::sync::Arc;

use tauri::State;

// -- Local Imports --
use crate::db;
use crate::dto::{CoverRef, CoverSource, PlaylistRow, PlaylistSnapshot};
use crate::state::AppState;

/// Loads every playlist with its slot count and every slot in play order, in one lock. Mirrors the
/// load_organization load-all shape.
#[tauri::command]
pub fn load_playlists(state: State<'_, AppState>) -> Result<PlaylistSnapshot, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::load_playlists(&conn).map_err(|e| e.to_string())
}

/// Creates an empty playlist with an optional name, returning the fresh row.
#[tauri::command]
pub fn create_playlist(
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<PlaylistRow, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::create_playlist(&conn, name, super::now_unix()).map_err(|e| e.to_string())
}

/// Renames a playlist (a None clears its name back to the display default) and bumps updated_at.
#[tauri::command]
pub fn rename_playlist(
    id: i64,
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::rename_playlist(&conn, id, name, super::now_unix()).map_err(|e| e.to_string())
}

/// Deletes a playlist. Its slots cascade away; the tracks themselves stay.
#[tauri::command]
pub fn delete_playlist(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::delete_playlist(&conn, id).map_err(|e| e.to_string())
}

/// Appends tracks to a playlist as new slots after its current last position. A track already in the
/// playlist is appended again, not skipped - duplicates are intentional.
#[tauri::command]
pub fn add_tracks_to_playlist(
    playlist_id: i64,
    track_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::add_tracks_to_playlist(&mut conn, playlist_id, &track_ids, super::now_unix())
        .map_err(|e| e.to_string())
}

/// Removes slots from their playlist by slot id. The remaining slots keep their positions; gaps are
/// fine.
#[tauri::command]
pub fn remove_playlist_slots(
    slot_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::remove_playlist_slots(&mut conn, &slot_ids).map_err(|e| e.to_string())
}

/// Rewrites a playlist's slot order to the given sequence (position 1..N), keyed on slot id.
#[tauri::command]
pub fn set_playlist_order(
    playlist_id: i64,
    ordered_slot_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_playlist_order(&mut conn, playlist_id, &ordered_slot_ids, super::now_unix())
        .map_err(|e| e.to_string())
}

/// Sets a playlist's description (a None clears it back to unset) and bumps updated_at.
#[tauri::command]
pub fn set_playlist_description(
    id: i64,
    description: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_playlist_description(&conn, id, description, super::now_unix()).map_err(|e| e.to_string())
}

/// Imports a picked image as a playlist's cover. The image is decoded and both cache sizes are
/// written before any DB row is touched, so an unreadable file leaves nothing half-written. The
/// manifest row and the binding land together in one transaction. Returns the peek-size cover.
#[tauri::command]
pub async fn set_playlist_cover(
    id: i64,
    src_path: String,
    state: State<'_, AppState>,
) -> Result<CoverRef, String> {
    let created_at = super::now_unix();
    let covers_dir = state.covers_dir.clone();
    let guard = Arc::clone(&state.covers_in_flight);
    let src = src_path.clone();

    let (record, detail_path, width, height) = tauri::async_runtime::spawn_blocking(move || {
        super::covers::import_from_disk(&covers_dir, &guard, &src, created_at)
    })
    .await
    .map_err(|_| "cover task failed to run".to_string())??;

    // Write only after a clean decode: the manifest row and the playlist binding land together.
    {
        let mut conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let cover_id = db::upsert_cover(&tx, &record).map_err(|e| e.to_string())?;
        db::set_playlist_cover(&tx, id, cover_id, created_at).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }

    Ok(CoverRef {
        path: detail_path,
        width,
        height,
        source: CoverSource::Imported,
    })
}

/// Clears the cover the user bound to a playlist and bumps updated_at. A playlist has no member
/// fallback, so it is left with no cover.
#[tauri::command]
pub fn remove_playlist_cover(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::remove_playlist_cover(&conn, id, super::now_unix()).map_err(|e| e.to_string())
}
