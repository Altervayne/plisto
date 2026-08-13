/*
 * The managed application state. It owns the read connection behind a Mutex so any command can
 * reach the index while a scan writes through its own connection. It also carries what the scan
 * needs: the DB path (for the writer to open its own write connection), the cancel flag, and a
 * guard that rejects a second concurrent scan.
 */

// -- Library Imports --
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

/// Held in Tauri's managed state for the app's lifetime. `db` is the read connection; the Mutex
/// serializes access since rusqlite's Connection is not Sync. `cancel` is shared with the
/// running scan's workers; `scan_running` is the guard that keeps scans from overlapping.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub db_path: PathBuf,
    pub cancel: Arc<AtomicBool>,
    pub scan_running: AtomicBool,
}
