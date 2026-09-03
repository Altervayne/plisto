/*
 * The IPC command surface for the window and lifecycle actions the tray popup drives: show the main
 * window, and quit the app. Both are thin wrappers so the popup's buttons route through Rust rather
 * than plumbing a window handle from its own webview. The pop-out now-playing widget rides the same
 * surface, toggled and dismissed here so its callers never hold a window handle either.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

// -- Local Imports --
use crate::state::AppState;

/// The running jobs whose output would be lost to an abrupt quit, in a stable order. Discovery is
/// left out on purpose: the covers image sweep is a read-only, re-runnable pass, not lost work. The
/// keys name each job for the confirm dialog. An absent AppState (never, past setup) reads none.
fn work_losing_jobs(state: &AppState) -> Vec<&'static str> {
    let mut jobs = Vec::new();
    if state.scan_running.load(Ordering::Relaxed) {
        jobs.push("scan");
    }
    // Covers MTP too: the device transfer runs under the export guard, with no separate flag.
    if state.export_running.load(Ordering::Relaxed) {
        jobs.push("export");
    }
    if state.splice_running.load(Ordering::Relaxed) {
        jobs.push("splice");
    }
    if state.playlist_export_running.load(Ordering::Relaxed) {
        jobs.push("playlist_export");
    }
    jobs
}

/// Quits, but never over a running job that would lose work: when one is running it surfaces the
/// main window and emits `app:confirm-quit` with the running job keys, so the confirm dialog can
/// name them and route "Quit anyway" back through `confirm_quit`. Otherwise it exits at once. The
/// single door every quit path shares - the tray Quit, the tray menu, and the idle window close -
/// so a stray Quit can never dodge the warning.
pub fn guarded_quit(app: &AppHandle) {
    let running = app
        .try_state::<AppState>()
        .map(|state| work_losing_jobs(state.inner()))
        .unwrap_or_default();
    if running.is_empty() {
        app.exit(0);
        return;
    }
    crate::tray::show_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("app:confirm-quit", &running);
    }
}

/// Brings the main window back from the tray: shows, unminimizes and focuses it.
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::tray::show_main_window(&app);
}

/// Quits the app from the tray popup, through the shared guard so a running job warns first.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    guarded_quit(&app);
}

/// The "Quit anyway" path from the running-job warning: signals every worker to stop, then exits.
/// Best-effort - it does not await the workers, so a partial output file may remain. Setting an
/// idle job's cancel flag is harmless. Exit drops AppState, which drops the player Sender and closes
/// the engine channel, so the resident thread ends with it.
#[tauri::command]
pub fn confirm_quit(app: AppHandle, state: State<'_, AppState>) {
    state.cancel.store(true, Ordering::Relaxed);
    state.export_cancel.store(true, Ordering::Relaxed);
    state.splice_cancel.store(true, Ordering::Relaxed);
    state.discovery_cancel.store(true, Ordering::Relaxed);
    state.playlist_export_cancel.store(true, Ordering::Relaxed);
    app.exit(0);
}

/// Toggles the pop-out now-playing widget from the mini-player or the tray block: hides it when
/// visible, else seats it and shows it. Never focuses it - the widget floats over every app without
/// stealing the foreground.
#[tauri::command]
pub fn toggle_now_playing_widget(app: AppHandle) {
    let Some(window) = app.get_webview_window("nowplaying") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        crate::tray::seat_now_playing(&app, &window);
        let _ = window.show();
        // Re-assert topmost on every show: the config flag is not reliably re-applied to a window
        // created hidden, so without this the widget can surface behind other windows.
        let _ = window.set_always_on_top(true);
        // Push the current snapshot straight to the freshly-shown widget, so it names the track and
        // arms its transport at once even if it missed the events that fired while it was hidden.
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(status) = state.player_status.lock() {
                let _ = window.emit("player:status", status.clone());
            }
        }
    }
}

/// Hides the pop-out now-playing widget, driven by its own close button.
#[tauri::command]
pub fn hide_now_playing_widget(app: AppHandle) {
    if let Some(window) = app.get_webview_window("nowplaying") {
        let _ = window.hide();
    }
}
