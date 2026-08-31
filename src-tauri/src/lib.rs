// -- Module Declarations --
mod audio;
mod commands;
mod covers;
mod db;
mod discovery;
mod dto;
mod export;
mod model;
mod normalize;
mod paths;
mod resolve;
mod scan;
mod state;
mod tray;

// -- Library Imports --
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Manager, WindowEvent};

// -- State Imports --
use covers::InFlightGuard;
use dto::ExportStatus;
use state::AppState;
use tray::TrayState;

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
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| match event {
            // The main window's close (the X, native or the custom titlebar's JS close()) hides to
            // tray instead of exiting; the app keeps running behind the tray icon. Minimize is left
            // to its normal behavior. The tray popup's own close is never intercepted.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The pop-out widget's close (a native X or its own close button routing through hide)
            // hides rather than destroys, so re-summoning it later reuses the same window.
            WindowEvent::CloseRequested { api, .. } if window.label() == "nowplaying" => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The popup dismisses itself when it loses focus, like a native popover.
            WindowEvent::Focused(false) if window.label() == "tray" => {
                let _ = window.hide();
                tray::stamp_hidden(window.app_handle());
            }
            _ => {}
        })
        .setup(|app| {
            // The index lives in the app data dir, never the music folder. Open it once on
            // launch and hand ownership to managed state.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("plisto.sqlite");
            let mut conn = db::open_db(&db_path)?;

            // Fill any root's folded key left NULL by the migration, using the real normalize (SQL
            // lower() is ASCII-only and would break fold-parity). Idempotent, and cheap enough to
            // run inline before managed state takes the connection.
            db::fill_root_keys(&conn)?;

            // Seed the genre vocabulary from the pre-existing album-level genres, once, so export
            // output is unchanged after the per-track edit layer lands. Needs the real Unicode
            // case-fold (SQL lower() is ASCII-only), so it runs here like the root_key fill; a
            // settings marker makes it a no-op on every later launch.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            db::backfill_genres_from_albums(&mut conn, now)?;

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

            // The resident player thread owns the audio output for the app's life. Spawn it before
            // managed state takes the Sender, seeding the shared snapshot the status command reads.
            // The Sender stays single-owned in AppState: dropping it at exit closes the channel and
            // ends the thread, so it must never be cloned elsewhere.
            let (player_tx, player_rx) = crossbeam_channel::unbounded::<audio::PlayerCmd>();
            let player_status = Arc::new(Mutex::new(audio::PlayerStatus::default()));
            audio::engine::spawn(player_rx, Arc::clone(&player_status), app.handle().clone());

            // Re-pin the persisted output device, if one was chosen. Absent or empty means follow the
            // system default, which the engine already does from its initial build, so nothing is
            // sent. Best-effort: a read failure leaves playback on the default.
            if let Ok(Some(name)) = db::get_setting(&conn, "output_device") {
                if !name.is_empty() {
                    let _ = player_tx.send(audio::PlayerCmd::SetOutputDevice(Some(name)));
                }
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
                playlist_export_cancel: Arc::new(AtomicBool::new(false)),
                playlist_export_running: AtomicBool::new(false),
                discovery_cancel: Arc::new(AtomicBool::new(false)),
                discovery_running: AtomicBool::new(false),
                export_status: Arc::new(Mutex::new(ExportStatus {
                    running: false,
                    progress: None,
                })),
                player: player_tx,
                player_status,
            });

            // The tray icon and its popup toggle guard, once the state it reads is managed.
            app.manage(TrayState::default());
            tray::build_tray(app.handle())?;

            // Round the opaque pop-out widget's corners through DWM so it reads as a card, not a
            // square. Runs once at setup; a no-op off Windows.
            if let Some(widget) = app.get_webview_window("nowplaying") {
                tray::round_corners(&widget);
            }

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
            commands::covers::playlist_cover,
            commands::covers::list_cover_candidates,
            commands::covers::list_folder_images,
            commands::covers::import_folder_cover,
            commands::covers::import_folder_cover_by_path,
            commands::covers::image_thumb,
            commands::covers::remove_folder_cover,
            commands::covers::import_track_cover,
            commands::covers::remove_track_cover,
            commands::covers::save_track_cover,
            commands::covers::track_cover_ext,
            commands::discovery::discover_library_images,
            commands::discovery::cancel_discovery,
            commands::organize::create_album,
            commands::organize::create_single,
            commands::organize::delete_album,
            commands::organize::add_tracks_to_album,
            commands::organize::remove_tracks_from_album,
            commands::organize::set_track_order,
            commands::organize::set_album_layout,
            commands::organize::set_album_fields,
            commands::organize::set_track_overrides,
            commands::organize::set_track_edit,
            commands::organize::get_track_edit,
            commands::organize::get_track_display,
            commands::organize::set_album_cover,
            commands::organize::remove_album_cover,
            commands::organize::set_track_keep_own_cover,
            commands::organize::load_organization,
            commands::organize::list_genres,
            commands::organize::create_genre,
            commands::organize::rename_genre,
            commands::organize::delete_genre,
            commands::organize::genre_removal_impact,
            commands::organize::merge_genres,
            commands::organize::set_track_genres,
            commands::organize::add_album_genre,
            commands::organize::remove_album_genre,
            commands::organize::apply_album_fields_to_members,
            commands::playlists::load_playlists,
            commands::playlists::create_playlist,
            commands::playlists::rename_playlist,
            commands::playlists::delete_playlist,
            commands::playlists::add_tracks_to_playlist,
            commands::playlists::remove_playlist_slots,
            commands::playlists::set_playlist_order,
            commands::playlists::set_playlist_description,
            commands::playlists::set_playlist_cover,
            commands::playlists::remove_playlist_cover,
            commands::export::export_library,
            commands::export::cancel_export,
            commands::export::export_template_preview,
            commands::export::validate_export_destination,
            commands::export::get_export_status,
            commands::export::pick_device_folder,
            commands::export::check_device,
            commands::playlist_export::export_playlist_m3u,
            commands::playlist_export::export_playlist_rich_m3u8,
            commands::playlist_export::export_playlist_folder,
            commands::playlist_export::export_playlist_mimic_album,
            commands::playlist_export::cancel_playlist_export,
            commands::extract::extract_preview,
            commands::extract::extract_apply,
            commands::bulk_edit::bulk_edit_tracks,
            commands::bulk_edit::apply_track_titles,
            commands::roots::list_roots,
            commands::roots::add_root,
            commands::roots::remove_root,
            commands::roots::rescan_root,
            commands::roots::rescan_all,
            commands::roots::root_removal_impact,
            commands::window::show_main_window,
            commands::window::quit_app,
            commands::window::toggle_now_playing_widget,
            commands::window::hide_now_playing_widget,
            commands::player::player_play_tracks,
            commands::player::player_toggle,
            commands::player::player_pause,
            commands::player::player_resume,
            commands::player::player_stop,
            commands::player::player_next,
            commands::player::player_prev,
            commands::player::player_seek,
            commands::player::player_set_volume,
            commands::player::player_set_repeat,
            commands::player::get_player_status,
            commands::player::list_output_devices,
            commands::player::player_set_output_device
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
