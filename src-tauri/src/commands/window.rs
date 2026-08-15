/*
 * The IPC command surface for the window and lifecycle actions the tray popup drives: show the main
 * window, and quit the app. Both are thin wrappers so the popup's buttons route through Rust rather
 * than plumbing a window handle from its own webview.
 */

// -- Library Imports --
use tauri::AppHandle;

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
