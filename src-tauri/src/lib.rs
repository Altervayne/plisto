// -- Module Declarations --
mod commands;
mod covers;
mod db;
mod dto;
mod export;
mod model;
mod normalize;
mod paths;
mod resolve;
mod scan;
mod state;

// -- Library Imports --
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::Manager;

// -- State Imports --
use covers::InFlightGuard;
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The index lives in the app data dir, never the music folder. Open it once on
            // launch and hand ownership to managed state.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("plisto.sqlite");
            let conn = db::open_db(&db_path)?;

            // Fill any root's folded key left NULL by the migration, using the real normalize (SQL
            // lower() is ASCII-only and would break fold-parity). Idempotent, and cheap enough to
            // run inline before managed state takes the connection.
            db::fill_root_keys(&conn)?;

            // Thumbnails and the full-res cover blobs cache beside the index, never in the music
            // folder. The webview reads thumbnails back through the asset protocol scoped here.
            let covers_dir = data_dir.join("covers");
            std::fs::create_dir_all(&covers_dir)?;

            let covers_in_flight = Arc::new(InFlightGuard::default());

            // Copy any imported cover picked before the full-res store existed into the store,
            // once, off the launch thread. The manifest is read here so no extra connection is
            // opened; the file work runs in the background and a missing or changed origin is
            // left for export to report.
            let pending = db::imported_full_res_origins(&conn).unwrap_or_default();
            if !pending.is_empty() {
                let covers_dir = covers_dir.clone();
                let guard = Arc::clone(&covers_in_flight);
                tauri::async_runtime::spawn_blocking(move || {
                    commands::covers::backfill_full_res(&covers_dir, &guard, &pending);
                });
            }

            app.manage(AppState {
                db: Mutex::new(conn),
                db_path,
                cancel: Arc::new(AtomicBool::new(false)),
                scan_running: AtomicBool::new(false),
                covers_dir,
                covers_in_flight,
                export_cancel: Arc::new(AtomicBool::new(false)),
                export_running: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            commands::scan_workspace,
            commands::cancel_scan,
            commands::list_tracks,
            commands::settings::workspace_root,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::covers::read_cover,
            commands::covers::album_cover,
            commands::covers::list_cover_candidates,
            commands::covers::import_folder_cover,
            commands::covers::remove_folder_cover,
            commands::organize::create_album,
            commands::organize::create_single,
            commands::organize::delete_album,
            commands::organize::add_tracks_to_album,
            commands::organize::remove_tracks_from_album,
            commands::organize::set_track_order,
            commands::organize::set_album_fields,
            commands::organize::set_track_overrides,
            commands::organize::set_album_cover,
            commands::organize::load_organization,
            commands::export::export_library,
            commands::export::cancel_export,
            commands::export::validate_export_destination,
            commands::roots::list_roots,
            commands::roots::add_root,
            commands::roots::remove_root,
            commands::roots::rescan_root,
            commands::roots::rescan_all,
            commands::roots::root_removal_impact
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
