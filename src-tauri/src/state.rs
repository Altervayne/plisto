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

// -- Local Imports --
use crate::covers::InFlightGuard;
use crate::dto::ExportStatus;

/// Held in Tauri's managed state for the app's lifetime. `db` is the read connection; the Mutex
/// serializes access since rusqlite's Connection is not Sync. `cancel` is shared with the
/// running scan's workers; `scan_running` is the guard that keeps scans from overlapping.
/// `covers_dir` is where thumbnails are cached; `covers_in_flight` collapses concurrent
/// identical thumbnail generations to one decode. `export_cancel`/`export_running` are the
/// export's own cancel flag and overlap guard, kept separate from the scan pair so cancelling
/// one never touches the other. `playlist_export_cancel`/`playlist_export_running` are the
/// self-contained playlist folder export's own pair, kept separate again so a playlist export and a
/// library export never cancel or block each other. `export_status` is the app-global snapshot the
/// tray popup reads and the export worker updates from its blocking thread, so it is an Arc the
/// worker closure can hold while the command still reads it through managed state.
pub struct AppState {
    pub db: Mutex<Connection>,
    pub db_path: PathBuf,
    pub cancel: Arc<AtomicBool>,
    pub scan_running: AtomicBool,
    pub covers_dir: PathBuf,
    pub covers_in_flight: Arc<InFlightGuard>,
    pub export_cancel: Arc<AtomicBool>,
    pub export_running: AtomicBool,
    pub playlist_export_cancel: Arc<AtomicBool>,
    pub playlist_export_running: AtomicBool,
    pub export_status: Arc<Mutex<ExportStatus>>,
}
