/*
 * The IPC command surface for client preferences and the workspace anchor: a small key-value
 * store for prefs, plus a read of the active workspace root. Every access goes through the shared
 * read connection's Mutex - the same single writer the other commands use, no extra connection.
 */

// -- Library Imports --
use std::sync::atomic::Ordering;

use tauri::State;

// -- Local Imports --
use crate::audio::PlayerCmd;
use crate::db;
use crate::library_sync::SyncCmd;
use crate::loudness::LoudnessCmd;
use crate::plugins::api::app::{
    SETTING_APP_MODE, SETTING_LOCALE, SETTING_PLAYER_ENABLED, SETTING_THEME,
};
use crate::plugins::api::events::Input;
use crate::plugins::api::state::ApiState;
use crate::sound_settings::{self, Levelling};
use crate::state::AppState;

/// The first library root's path, or None when the library is empty. The interim single-folder
/// reader until the frontend reads the whole root list.
#[tauri::command]
pub fn workspace_root(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::first_root_path(&conn).map_err(|e| e.to_string())
}

/// Keys starting with `plugin` are refused in both directions: plugin state lives outside the library
/// database, and the generic store must not become a way into it.
fn guard_key(key: &str) -> Result<(), String> {
    if key.to_ascii_lowercase().starts_with("plugin") {
        return Err("this setting is not available".to_string());
    }
    Ok(())
}

/// The value stored under `key`, or None when it is unset. A client pref falls back to its own
/// default on None.
#[tauri::command]
pub fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    guard_key(&key)?;
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::get_setting(&conn, &key).map_err(|e| e.to_string())
}

/// Stores `value` under `key`, replacing any prior value.
#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    guard_key(&key)?;
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    db::set_setting(&conn, &key, &value).map_err(|e| e.to_string())?;
    // Keep the close-behavior mirror fresh, so the window-event handler never has to read the kv.
    if key == "closeToTray" {
        state.close_to_tray.store(value == "1", Ordering::Relaxed);
    }
    if key == "keepLibraryUpToDate" {
        let on = value != "0";
        state.keep_library_up_to_date.store(on, Ordering::Relaxed);
        let _ = state.library_sync.send(SyncCmd::SetEnabled(on));
    }
    if key == "sound" {
        let sound = sound_settings::parse(&value);
        let on = sound.levelling != Levelling::Off;
        let _ = state.loudness.send(LoudnessCmd::SetEnabled(on));
        let _ = state.player.send(PlayerCmd::SetSound(sound));
    }
    notify_plugins(&key, state.plugins.api());
    Ok(())
}

/// Tells the plugin event hub that a setting behind the theme, locale or app mode was written.
fn notify_plugins(key: &str, api: &ApiState) {
    let ambient = [
        SETTING_THEME,
        SETTING_LOCALE,
        SETTING_APP_MODE,
        SETTING_PLAYER_ENABLED,
    ];
    if ambient.contains(&key) {
        api.events().feed(Input::Ambient);
    }
}

/// Opens the Windows Default apps settings page, where the user picks Plisto per file type. Win8+
/// forbids setting the default programmatically, so the honest move is to send them straight to the
/// page rather than pretend it is done. A no-op off Windows, where there is no such page.
#[tauri::command]
pub fn open_default_apps_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url("ms-settings:defaultapps", None::<&str>)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_keys_are_refused() {
        for key in [
            "plugin",
            "plugins",
            "plugins.registry",
            "plugin_anything",
            "plugin.x",
            "pluginX",
            "Plugin",
            "PLUGINS.x",
        ] {
            assert!(guard_key(key).is_err(), "{key}");
        }
    }

    #[test]
    fn the_theme_locale_and_mode_keys_notify_plugins() {
        use crate::plugins::api::events::{Side, Topic};
        use std::collections::BTreeSet;

        let api = ApiState::default();
        let (tx, rx) = crossbeam_channel::unbounded();
        api.events().attach(tx);
        let topics: BTreeSet<Topic> = [Topic::Theme].into();
        api.events()
            .replace("com.example.demo", Side::Frame, &topics, &[]);
        for key in ["sound", "closeToTray", "drawer_width", "Theme"] {
            notify_plugins(key, &api);
        }
        assert!(rx.try_recv().is_err());
        for key in ["theme", "locale", "app_mode", "player_enabled"] {
            notify_plugins(key, &api);
            assert!(matches!(rx.try_recv(), Ok(Input::Ambient)), "{key}");
        }
    }

    #[test]
    fn every_existing_key_passes() {
        for key in [
            "drawer_width",
            "locale",
            "theme",
            "app_mode",
            "output_device",
            "closeToTray",
            "keepLibraryUpToDate",
            "sound",
            "player_visualizer",
            "player_visualizer_reactivity",
            "player_spectrum_layout",
            "player_resume",
            "player_enabled",
            "updater_auto_check",
            "collection_segment",
            "finder_recent",
            "home_layout_player",
            "",
            "a_plugin",
            "plug",
        ] {
            assert!(guard_key(key).is_ok(), "{key}");
        }
    }
}
