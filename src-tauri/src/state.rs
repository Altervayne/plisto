/*
 * The managed application state. It owns the read connection behind a Mutex so any command can
 * reach the index. The scan writer gets its own connection later; this one stays for reads.
 */

// -- Library Imports --
use std::sync::Mutex;

use rusqlite::Connection;

/// Held in Tauri's managed state for the app's lifetime. `db` is the read connection; the
/// Mutex serializes access since rusqlite's Connection is not Sync.
pub struct AppState {
    #[allow(dead_code)]
    pub db: Mutex<Connection>,
}
