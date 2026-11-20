/*
 * The managed application state. It owns the read connection behind a Mutex so any command can
 * reach the index while a scan writes through its own connection. It also carries what the scan
 * needs: the DB path (for the writer to open its own write connection), the cancel flags, and the
 * scan lock that keeps a second writer out.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

// -- Local Imports --
use crate::adhoc::AdHocTrack;
use crate::audio::{PlayerCmd, PlayerNotice, PlayerStatus, QueueMirror};
use crate::covers::InFlightGuard;
use crate::dto::{ExportStatus, LibrarySyncStatus, WriteRecovery};
use crate::library_sync::SyncCmd;
use crate::loudness::LoudnessCmd;
use crate::plugins::api::stream::StreamHub;
use crate::plugins::state::PluginsState;
use crate::scan_lock::Holder;

/// Everything shared across commands and background threads, held by Tauri for the app's life. The
/// wrapper on each field says how it is shared.
pub struct AppState {
    /// Mutex because rusqlite's Connection is not Sync.
    pub db: Mutex<Connection>,
    pub db_path: PathBuf,
    // Each long job owns a cancel flag and an overlap guard, kept as separate pairs so cancelling or
    // running one never touches another: scan, export, splice, playlist export, discovery sweep.
    pub cancel: Arc<AtomicBool>,
    /// Who holds the scan lock; taken and released only through `scan_lock`.
    pub scan_holder: Mutex<Option<Holder>>,
    /// Mirrors of `scan_holder` for readers that only peek: any holder, and a background holder.
    pub scan_running: AtomicBool,
    pub bg_active: AtomicBool,
    /// The background pass's own cancel flag, raised by a preempting user taker, a user cancel, or
    /// quit. Kept apart from `cancel` so a user scan never reads a background stop.
    pub bg_cancel: Arc<AtomicBool>,
    /// The handle to the library-sync thread.
    pub library_sync: crossbeam_channel::Sender<SyncCmd>,
    /// The library-sync snapshot the thread writes and the status command reads.
    pub library_sync_status: Mutex<LibrarySyncStatus>,
    /// Atomic like `close_to_tray`, so the sync thread and the status read never touch the kv.
    pub keep_library_up_to_date: AtomicBool,
    /// The handle to the loudness worker.
    pub loudness: crossbeam_channel::Sender<LoudnessCmd>,
    pub covers_dir: PathBuf,
    /// Collapses identical concurrent thumbnail generations to a single decode.
    pub covers_in_flight: Arc<InFlightGuard>,
    pub export_cancel: Arc<AtomicBool>,
    pub export_running: AtomicBool,
    pub splice_cancel: Arc<AtomicBool>,
    pub splice_running: AtomicBool,
    pub playlist_export_cancel: Arc<AtomicBool>,
    pub playlist_export_running: AtomicBool,
    pub discovery_cancel: Arc<AtomicBool>,
    pub discovery_running: AtomicBool,
    /// Set while a command writes to a music file; exports and structural commands refuse meanwhile.
    pub file_write_running: AtomicBool,
    pub file_write_cancel: Arc<AtomicBool>,
    /// Raised by a user taker of the scan lock, so a file-write holder lets go between files.
    pub file_write_yield: AtomicBool,
    /// What recovery settled since the front end last asked: the boot run and every scan-time run
    /// merged, taken and cleared by `take_file_write_recovery`.
    pub write_recovery: Mutex<Option<WriteRecovery>>,
    /// The keys of every held row reported this session, so a row held across scans is reported once.
    pub write_reported: Mutex<HashSet<String>>,
    /// Export progress the tray reads and the worker writes; Arc so both hold it at once.
    pub export_status: Arc<Mutex<ExportStatus>>,
    /// The one handle to the audio thread. Never cloned: dropping AppState at exit closes the channel,
    /// which ends the thread.
    pub player: crossbeam_channel::Sender<PlayerCmd>,
    /// The live playback snapshot the engine writes and commands read.
    pub player_status: Arc<Mutex<PlayerStatus>>,
    /// The ordered queue ids and block spans, rewritten only when the queue changes, never on the
    /// status tick. One lock, so a reader never sees ids and spans from two different queues.
    pub player_queue: Arc<Mutex<QueueMirror>>,
    /// Tracks played off disk with no library row, keyed by the negative id the engine reports back.
    pub ad_hoc: Mutex<HashMap<i64, AdHocTrack>>,
    /// Atomic so the window-close handler reads it without taking the db Mutex.
    pub close_to_tray: AtomicBool,
    /// Files the OS cold-launched Plisto with; taken once by get_startup_file, None otherwise.
    pub startup_file: Mutex<Option<Vec<String>>>,
    /// Set when an OS-launch batch was wholly unreadable; taken once by get_startup_error.
    pub startup_error: Mutex<Option<PlayerNotice>>,
    /// Set once the main webview's plugin frame handler is installed; false means no frame may mount.
    pub frames_ready: AtomicBool,
    /// The plugin registry, boot findings and the set of plugins the frame host serves.
    pub plugins: PluginsState,
}

impl AppState {
    /// The plugin playback stream session.
    pub fn streams(&self) -> &StreamHub {
        self.plugins.api().streams()
    }

    /// Adds what a recovery run settled to the report the front end takes next. A held row already
    /// reported this session is left out, and an empty run adds nothing, so a quiet scan never raises
    /// the notice.
    pub fn note_write_recovery(&self, found: WriteRecovery) {
        let found = {
            let mut reported = self.write_reported.lock().unwrap_or_else(|e| e.into_inner());
            found.unreported(&mut reported)
        };
        if found.is_empty() {
            return;
        }
        let mut held = self.write_recovery.lock().unwrap_or_else(|e| e.into_inner());
        match held.as_mut() {
            Some(report) => report.merge(found),
            None => *held = Some(found),
        }
    }
}

#[cfg(test)]
impl AppState {
    /// A minimal state for the resolver tests: the given index connection and covers dir, every
    /// background guard idle, and dead player and sync channels (their receivers are dropped, so a
    /// send is a silent no-op). Lets a sentinel test drive the real command helpers without launching
    /// Tauri or the resident engine.
    pub(crate) fn for_test(db: Connection, covers_dir: PathBuf) -> Self {
        let (player, _rx) = crossbeam_channel::unbounded();
        let (library_sync, _sync_rx) = crossbeam_channel::unbounded();
        let (loudness, _loudness_rx) = crossbeam_channel::unbounded();
        Self {
            db: Mutex::new(db),
            db_path: PathBuf::new(),
            cancel: Arc::new(AtomicBool::new(false)),
            scan_holder: Mutex::new(None),
            scan_running: AtomicBool::new(false),
            bg_active: AtomicBool::new(false),
            bg_cancel: Arc::new(AtomicBool::new(false)),
            library_sync,
            library_sync_status: Mutex::new(LibrarySyncStatus::default()),
            keep_library_up_to_date: AtomicBool::new(true),
            loudness,
            covers_dir,
            covers_in_flight: Arc::new(crate::covers::InFlightGuard::default()),
            export_cancel: Arc::new(AtomicBool::new(false)),
            export_running: AtomicBool::new(false),
            splice_cancel: Arc::new(AtomicBool::new(false)),
            splice_running: AtomicBool::new(false),
            playlist_export_cancel: Arc::new(AtomicBool::new(false)),
            playlist_export_running: AtomicBool::new(false),
            discovery_cancel: Arc::new(AtomicBool::new(false)),
            discovery_running: AtomicBool::new(false),
            file_write_running: AtomicBool::new(false),
            file_write_cancel: Arc::new(AtomicBool::new(false)),
            file_write_yield: AtomicBool::new(false),
            write_recovery: Mutex::new(None),
            write_reported: Mutex::new(HashSet::new()),
            export_status: Arc::new(Mutex::new(ExportStatus {
                running: false,
                progress: None,
            })),
            player,
            player_status: Arc::new(Mutex::new(PlayerStatus::default())),
            player_queue: Arc::new(Mutex::new(QueueMirror::default())),
            ad_hoc: Mutex::new(HashMap::new()),
            close_to_tray: AtomicBool::new(false),
            startup_file: Mutex::new(None),
            startup_error: Mutex::new(None),
            frames_ready: AtomicBool::new(false),
            plugins: PluginsState::empty(),
        }
    }
}
