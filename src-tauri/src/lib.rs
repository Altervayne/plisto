// -- Module Declarations --
mod db;
mod model;
mod normalize;
mod state;

// -- Library Imports --
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

// -- State Imports --
use state::AppState;

// Mirrors AppInfo in the frontend's types.ts. Any change here changes the IPC
// contract, so the two move together.
#[derive(Serialize)]
struct AppInfo {
    name: String,
    version: String,
}

// The first command across the IPC boundary. Proves the round-trip and returns a
// serde struct so the frontend reads a typed payload, not a bare string.
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "Plisto".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // The index lives in the app data dir, never the music folder. Open it once on
            // launch and hand ownership to managed state.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open_db(&data_dir.join("plisto.sqlite"))?;
            app.manage(AppState {
                db: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
