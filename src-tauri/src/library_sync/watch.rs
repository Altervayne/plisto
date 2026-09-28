/*
 * The change watcher: one notify watcher, one recursive watch per root, and only on local fixed
 * drives. Network and removable drives are left to focus polling: their change feed cannot be
 * trusted. The watcher is created on the first arm and forwards every event into the sync thread's
 * own channel.
 */

// -- Library Imports --
use std::path::Path;

use crossbeam_channel::Sender;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

// -- Local Imports --
use super::SyncCmd;

pub struct Watches {
    watcher: Option<RecommendedWatcher>,
    tx: Sender<SyncCmd>,
}

impl Watches {
    pub fn new(tx: Sender<SyncCmd>) -> Self {
        Self { watcher: None, tx }
    }

    /// Starts a recursive watch on `root`. False when the root is not on a local fixed drive or the
    /// watch could not be set up, in which case the root is polled instead.
    pub fn arm(&mut self, root: &Path) -> bool {
        if !is_fixed_drive(root) {
            return false;
        }
        if self.watcher.is_none() {
            let tx = self.tx.clone();
            self.watcher = RecommendedWatcher::new(
                move |res| {
                    let _ = tx.send(SyncCmd::Fs(res));
                },
                Config::default(),
            )
            .ok();
        }
        match self.watcher.as_mut() {
            Some(watcher) => watcher.watch(root, RecursiveMode::Recursive).is_ok(),
            None => false,
        }
    }

    /// Stops watching `root`. Unwatching a root that was never armed is harmless.
    pub fn disarm(&mut self, root: &Path) {
        if let Some(watcher) = self.watcher.as_mut() {
            let _ = watcher.unwatch(root);
        }
    }
}

/// Whether `path` lives on a local fixed drive.
#[cfg(windows)]
fn is_fixed_drive(path: &Path) -> bool {
    use std::path::Component;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows::Win32::System::WindowsProgramming::DRIVE_FIXED;

    // GetDriveTypeW wants the volume root itself, with its trailing backslash.
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return false;
    };
    let wide: Vec<u16> = format!("{}\\", prefix.as_os_str().to_string_lossy())
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) == DRIVE_FIXED }
}

/// No drive-type query off Windows: every root is watched.
#[cfg(not(windows))]
fn is_fixed_drive(_path: &Path) -> bool {
    true
}
