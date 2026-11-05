/*
 * The IPC command surface for loudness levelling: the coverage read behind the Settings line. The
 * measurement itself runs on the loudness worker; this only counts, through the shared read connection.
 */

// -- Library Imports --
use tauri::State;

// -- Local Imports --
use crate::dto::LoudnessCoverage;
use crate::loudness::queue;
use crate::state::AppState;

/// How the present tracks stand for levelling: tagged, measured, unmeasurable and still pending.
#[tauri::command]
pub fn loudness_coverage(state: State<'_, AppState>) -> Result<LoudnessCoverage, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    queue::coverage(&conn).map_err(|e| e.to_string())
}
