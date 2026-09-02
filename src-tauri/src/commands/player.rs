/*
 * The IPC command surface for playback. This is the only player file that touches the database: it
 * resolves track ids to file paths, then hands a DB-free queue to the resident engine over the
 * command channel. Every transport command is a fire-and-forget send - the engine owns all state
 * and reports back through `player:status` events and the shared snapshot `get_player_status` reads.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::PathBuf;

use rodio::cpal;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use tauri::State;

// -- Local Imports --
use crate::audio::{OutputDeviceInfo, PlayerCmd, PlayerStatus, QueueTrack, RepeatMode};
use crate::db;
use crate::state::AppState;

/// Resolves track ids to a DB-free queue, keeping the caller's order and dropping ids that no longer
/// resolve (a deleted row). `load_track_export_paths` returns only present ids in an arbitrary order,
/// so index them by id and rebuild along the requested sequence. The only DB work the player does;
/// the engine never sees a connection. Returns an empty queue when the lock is poisoned.
fn resolve_queue(track_ids: &[i64], state: &AppState) -> Vec<QueueTrack> {
    let resolved: Vec<(i64, String)> = match state.db.lock() {
        Ok(conn) => db::load_track_export_paths(&conn, track_ids).unwrap_or_default(),
        Err(_) => return Vec::new(),
    };
    let by_id: HashMap<i64, String> = resolved.into_iter().collect();
    track_ids
        .iter()
        .filter_map(|id| {
            by_id.get(id).map(|p| QueueTrack {
                id: *id,
                path: PathBuf::from(p),
            })
        })
        .collect()
}

/// Resolves the given track ids to their files and starts playback at `index`. Ids that no longer
/// resolve (a deleted row) drop out of the queue, so `index` is clamped to what remains. An empty
/// resolution is a no-op.
#[tauri::command]
pub fn player_play_tracks(
    track_ids: Vec<i64>,
    index: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let queue = resolve_queue(&track_ids, &state);
    if queue.is_empty() {
        return Ok(());
    }
    // Resolution may have dropped rows before `index`, so clamp to the surviving queue.
    let index = index.min(queue.len() - 1);
    let _ = state.player.send(PlayerCmd::Play { queue, index });
    Ok(())
}

/// Resolves the given track ids to their files and appends them to the end of the queue. An empty
/// resolution is a no-op. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_enqueue(track_ids: Vec<i64>, state: State<'_, AppState>) -> Result<(), String> {
    let queue = resolve_queue(&track_ids, &state);
    if queue.is_empty() {
        return Ok(());
    }
    let _ = state.player.send(PlayerCmd::Enqueue(queue));
    Ok(())
}

/// Moves the queue item at `from` to `to`, like a drag in the up-next list. Out-of-range indices are
/// ignored on the engine. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_move_queue_item(
    from: usize,
    to: usize,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::MoveQueueItem { from, to });
    Ok(())
}

/// Removes the queue item at `index`, like a delete in the up-next list. An out-of-range index is
/// ignored on the engine. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_remove_queue_item(index: usize, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::RemoveQueueItem { index });
    Ok(())
}

/// Auditions the file at `path` between `start_secs` and `end_secs` on the resident engine, stopping
/// at the out-point. A transient preview for the splicer workbench: it leaves the library queue and
/// cursor untouched, so playback restores after. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_preview(
    path: String,
    start_secs: f64,
    end_secs: f64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Preview {
        path: path.into(),
        start_secs,
        end_secs,
    });
    Ok(())
}

/// Reopens the current library track at `secs` and restores its paused state on the resident engine,
/// after a preview cleared the sink. Fire-and-forget like the other transport commands.
#[tauri::command]
pub fn player_restore_library(
    secs: f64,
    playing: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state
        .player
        .send(PlayerCmd::RestoreLibrary { secs, playing });
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

/// Jumps straight to the queue slot at `index`, like a click in the up-next list. The engine clamps
/// an over-range index to the last slot and skips a dead track forward, so this never lands nowhere.
#[tauri::command]
pub fn player_jump(index: usize, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::Jump(index));
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

/// Turns shuffle on or off. On materializes a shuffled queue order with the current track pinned to
/// the front; off restores the original insertion order. The current track keeps playing either way.
#[tauri::command]
pub fn player_set_shuffle(on: bool, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetShuffle(on));
    Ok(())
}

/// Enumerates the available output devices for the settings picker, flagging the current OS default.
/// Runs on the command worker thread - only names cross back, never a `!Send` device handle. The
/// engine builds its own device on its own thread when a pick arrives.
#[tauri::command]
pub fn list_output_devices() -> Result<Vec<OutputDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let list = devices
        .filter_map(|dev| dev.name().ok())
        .map(|name| OutputDeviceInfo {
            is_default: Some(&name) == default_name.as_ref(),
            name,
        })
        .collect();
    Ok(list)
}

/// Picks the output device: None follows the system default, Some pins that named device. Fire-and-
/// forget like the transport commands; the engine rebinds on its thread and reports back through the
/// status snapshot and any `player:error`.
#[tauri::command]
pub fn player_set_output_device(
    name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetOutputDevice(name));
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

/// The ordered queue track ids, for a UI building its up-next list on open or reconnect. Reads the
/// shared mirror the engine writes on every queue change, so it never waits on the `player:queue`
/// event. In the active play order, shuffled or not.
#[tauri::command]
pub fn get_player_queue(state: State<'_, AppState>) -> Result<Vec<i64>, String> {
    let queue = state
        .player_queue
        .lock()
        .map_err(|_| "player queue is unavailable".to_string())?;
    Ok(queue.clone())
}
