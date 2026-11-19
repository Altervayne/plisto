/*
 * Restore points: small SQLite files holding the library's organization (albums and singles,
 * membership, playlists and their slots, track edits, genres, per-track covers and visualizers),
 * written into their own folder beside the database and never into it. A point is built from the
 * database, never from what the frontend shows. Points are kept in one ring per reason.
 */

// -- Module Declarations --
mod collapse;
mod due;
mod format;
mod list;
mod load;
mod matching;
mod restore;
#[cfg(test)]
mod restore_tests;
mod retention;
mod take;
#[cfg(test)]
mod tests;

pub use due::{
    action_point_since, daily_due, newest_content_hash, version_point_due, BURST_WINDOW_MS,
};
pub use format::{Reason, DIR_NAME};
pub use list::{list, PointEntry, PointStatus};
pub use restore::{apply_restore, load_point, plan_restore, Applied, LoadedPoint, RestoreError};
pub use retention::disk_use;
pub use take::{finish, live_hash, stage, take, PointError, Staged, Taken};

// Read by the tests only.
#[cfg(test)]
pub use due::DAILY_INTERVAL_MS;
#[cfg(test)]
pub use list::PointMeta;
#[cfg(test)]
pub use retention::{prune, ring_size, DiskUse, Pruned};

// -- Library Imports --
use std::io;
use std::path::{Path, PathBuf};

/// The points folder of the library at `db_path`.
pub fn points_dir(db_path: &Path) -> PathBuf {
    db_path.with_file_name(DIR_NAME)
}

/// Whether `name` is a finished point's file name, and so names a file directly inside the points
/// folder.
pub fn is_point_name(name: &str) -> bool {
    format::parse_file_name(name).is_some()
}

/// A finished point file found in the folder, as its name and size describe it.
struct PointFile {
    path: PathBuf,
    name: String,
    created_at: i64,
    reason: Reason,
    bytes: u64,
}

/// Every finished point file in `dir`, in no particular order. A missing folder holds none; names
/// that are not a point's, `.tmp` files and directories are skipped.
fn point_files(dir: &Path) -> io::Result<Vec<PointFile>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some((created_at, reason)) = format::parse_file_name(&name) else {
            continue;
        };
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        files.push(PointFile {
            path: entry.path(),
            name,
            created_at,
            reason,
            bytes: meta.len(),
        });
    }
    Ok(files)
}
