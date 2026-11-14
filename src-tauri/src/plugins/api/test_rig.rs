/*
 * A test rig for the methods that read the app: one serving plugin over an in-memory library, called
 * through `dispatch` with a clock that moves a second per call so the rate buckets never get in the
 * way, and a player channel the test can read.
 */

// -- Library Imports --
use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::MutexGuard;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::Value;

// -- Local Imports --
use super::error::ApiError;
use super::{dispatch, FakeHost};
use crate::audio::PlayerCmd;
use crate::db;
use crate::plugins::manifest::{Capability, Tier};
use crate::plugins::registry::{Entry, EntryState, Registry};
use crate::plugins::revalidate::Problems;
use crate::plugins::session::BootState;
use crate::plugins::state::PluginsState;
use crate::state::AppState;

pub const ID: &str = "com.example.demo";

pub struct Rig {
    pub plugins: PluginsState,
    pub host: FakeHost,
    pub player: crossbeam_channel::Receiver<PlayerCmd>,
    t0: Instant,
    tick: Cell<u64>,
}

impl Rig {
    pub fn new(granted: &[Capability]) -> Rig {
        Rig::with_covers(granted, PathBuf::new())
    }

    pub fn with_covers(granted: &[Capability], covers_dir: PathBuf) -> Rig {
        Rig::build(
            granted,
            covers_dir,
            db::open_in_memory().unwrap(),
            PathBuf::new(),
        )
    }

    /// A rig over the database file at `path`, so plugin reads use their own connection.
    pub fn with_file_db(granted: &[Capability], path: &Path) -> Rig {
        Rig::build(
            granted,
            PathBuf::new(),
            db::open_db(path).unwrap(),
            path.to_path_buf(),
        )
    }

    fn build(
        granted: &[Capability],
        covers_dir: PathBuf,
        conn: Connection,
        db_path: PathBuf,
    ) -> Rig {
        let entry = Entry {
            id: ID.to_string(),
            version: "1.0.0".into(),
            tier: Tier::Ui,
            enabled: true,
            granted: granted.to_vec(),
            installed_at: 1,
            manifest_hash: "h".into(),
            state: EntryState::Ready,
            source_path: None,
            sidebar_collapsed: false,
            ready_enabled: None,
            consented_network: Vec::new(),
        };
        let registry = Registry {
            entries: vec![entry],
            ..Registry::default()
        };
        let mut app = AppState::for_test(conn, covers_dir);
        app.db_path = db_path;
        let (tx, rx) = crossbeam_channel::unbounded();
        app.player = tx;
        Rig {
            plugins: PluginsState::new(registry, Problems::new(), BootState::default()),
            host: FakeHost {
                app: Some(app),
                ..FakeHost::default()
            },
            player: rx,
            t0: Instant::now(),
            tick: Cell::new(0),
        }
    }

    pub fn state(&self) -> &AppState {
        self.host.app.as_ref().unwrap()
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.state().db.lock().unwrap()
    }

    pub fn call(&self, method: &str, args: Value) -> Result<Value, ApiError> {
        self.tick.set(self.tick.get() + 1);
        dispatch(
            &self.plugins.enabled_set(),
            self.plugins.api(),
            ID,
            method,
            &args.to_string(),
            Path::new("unused"),
            &self.host,
            self.t0 + Duration::from_secs(self.tick.get()),
        )
    }

    /// The player commands sent so far.
    pub fn sent(&self) -> Vec<PlayerCmd> {
        self.player.try_iter().collect()
    }
}

/// Inserts a present track at `path` with a raw title and artist, and returns its id.
pub fn insert_track(conn: &Connection, path: &str, title: &str, artist: &str) -> i64 {
    conn.execute(
        "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime, \
         raw_title, raw_artist, raw_album, raw_album_artist, raw_year, has_embedded_cover, scanned_at) \
         VALUES (?1, ?1, 'f.mp3', 'mp3', 10, 20, ?2, ?3, 'Raw Album', 'Raw AA', 1990, 0, 30)",
        rusqlite::params![path, title, artist],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// Marks a track as missing on disk.
pub fn mark_gone(conn: &Connection, id: i64) {
    conn.execute(
        "UPDATE tracks SET missing_at = 1 WHERE id = ?1",
        rusqlite::params![id],
    )
    .unwrap();
}
