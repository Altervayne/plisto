use serde::Serialize;

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
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
