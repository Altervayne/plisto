/*
 * The IPC command that turns the `player:wave` snapshot on or off.
 */

// -- Framework Imports --
use tauri::State;

// -- Local Imports --
use crate::audio::PlayerCmd;
use crate::state::AppState;

/// Turns the 256-value `player:wave` emit on or off. A visualizer that draws a scope turns it on
/// while mounted and off when it goes, so the window is picked only while something reads it.
#[tauri::command]
pub fn player_set_waveform(on: bool, state: State<'_, AppState>) -> Result<(), String> {
    let _ = state.player.send(PlayerCmd::SetWaveform(on));
    Ok(())
}
