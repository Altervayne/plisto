/*
 * The IPC command surface for playback. This is the only player file that touches the database: it
 * resolves track ids to file paths, then hands a DB-free queue to the resident engine over the
 * command channel. Every transport command is a fire-and-forget send - the engine owns all state
 * and reports back through `player:status` events and the shared snapshot `get_player_status` reads.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::PathBuf;

use tauri::State;

// -- Local Imports --
use crate::audio::{PlayerCmd, PlayerStatus, QueueTrack, RepeatMode};
use crate::db;
use crate::state::AppState;

/// Resolves the given track ids to their files and starts playback at `index`. Ids that no longer
/// resolve (a deleted row) drop out of the queue, so `index` is clamped to what remains. An empty
/// resolution is a no-op. The resolve is the only DB work; the engine never sees a connection.
#[tauri::command]
pub fn player_play_tracks(
    track_ids: Vec<i64>,
    index: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let resolved: Vec<(i64, String)> = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        db::load_track_export_paths(&conn, &track_ids).map_err(|e| e.to_string())?
    };

    // Keep the caller's order: `load_track_export_paths` returns only present ids in an arbitrary
    // order, so index them by id and rebuild the queue along the requested sequence.
    let by_id: HashMap<i64, String> = resolved.into_iter().collect();
    let queue: Vec<QueueTrack> = track_ids
        .iter()
        .filter_map(|id| {
            by_id.get(id).map(|p| QueueTrack {
                id: *id,
                path: PathBuf::from(p),
            })
        })
        .collect();

    if queue.is_empty() {
        return Ok(());
    }
    // Resolution may have dropped rows before `index`, so clamp to the surviving queue.
    let index = index.min(queue.len() - 1);
    let _ = state.player.send(PlayerCmd::Play { queue, index });
    Ok(())
}

/// Toggles between play and pause.
#[tauri::command]
pub fn player_toggle(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::TogglePlay);
    Ok(())
}

/// Pauses playback, holding the current position.
#[tauri::command]
pub fn player_pause(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Pause);
    Ok(())
}

/// Resumes from the held position.
#[tauri::command]
pub fn player_resume(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Resume);
    Ok(())
}

/// Stops playback and clears the current track.
#[tauri::command]
pub fn player_stop(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Stop);
    Ok(())
}

/// Skips to the next track, honoring the repeat mode.
#[tauri::command]
pub fn player_next(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Next);
    Ok(())
}

/// Steps back to the previous track.
#[tauri::command]
pub fn player_prev(state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Prev);
    Ok(())
}

/// Seeks the current track to `secs` from the start.
#[tauri::command]
pub fn player_seek(secs: f64, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Seek(secs));
    Ok(())
}

/// Sets the output volume, clamped to [0.0, 1.0] on the engine.
#[tauri::command]
pub fn player_set_volume(v: f32, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetVolume(v));
    Ok(())
}

/// Sets the repeat mode: off, all, or one.
#[tauri::command]
pub fn player_set_repeat(mode: RepeatMode, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetRepeat(mode));
    Ok(())
}

/// The current app-global playback snapshot, for a UI opening or reconnecting mid-play. Reads the
/// shared status the engine keeps live every tick, independent of the event stream.
#[tauri::command]
pub fn get_player_status(state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    let status = state
        .player_status
        .lock()
        .map_err(|_| "player status is unavailable".to_string())?;
    Ok(status.clone())
}
