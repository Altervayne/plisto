/*
 * The play-log listener. The resident engine stays DB-free: it resolves each listen's verdict and
 * emits `player:played`, and this thin listener does the one insert off the engine thread, holding the
 * index lock only for the write. A single Rust-side listener, not a per-webview frontend one, so a
 * listen counts once however many now-playing surfaces are open.
 */

// -- Library Imports --
use tauri::{AppHandle, Listener, Manager};

// -- Local Imports --
use crate::adhoc::is_ad_hoc;
use crate::audio::PlayReport;
use crate::db;
use crate::state::AppState;

/// Registers the `player:played` listener, once, at the setup tail beside the other player wiring. It
/// parses the report and inserts the play under a brief index lock. Best-effort: a poisoned lock or a
/// rare foreign-key failure (a track deleted between the emit and the insert) is swallowed, so a lost
/// play never disturbs playback.
pub fn init(app: &AppHandle) {
    let handle = app.clone();
    app.listen("player:played", move |event| {
        let Ok(report) = serde_json::from_str::<PlayReport>(event.payload()) else {
            return;
        };
        // Belt and suspenders: the engine already gates the emit, so a negative ad-hoc id never
        // reaches here, but guard again since it would violate the plays foreign key.
        if is_ad_hoc(report.track_id) {
            return;
        }
        if let Some(state) = handle.try_state::<AppState>() {
            if let Ok(conn) = state.db.lock() {
                let _ = db::insert_play(&conn, report.track_id, report.completed);
            }
        }
    });
}
