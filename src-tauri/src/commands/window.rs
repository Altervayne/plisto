/*
 * The IPC command surface for the window and lifecycle actions the tray popup drives: show the main
 * window, and quit the app. Both are thin wrappers so the popup's buttons route through Rust rather
 * than plumbing a window handle from its own webview. The pop-out now-playing widget rides the same
 * surface, toggled and dismissed here so its callers never hold a window handle either.
 */

// -- Library Imports --
use tauri::{AppHandle, Emitter, Manager};

// -- Local Imports --
use crate::state::AppState;

/// Brings the main window back from the tray: shows, unminimizes and focuses it.
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::tray::show_main_window(&app);
}

/// Quits the app from the tray popup.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
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
