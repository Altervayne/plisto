/*
 * The kept backups a trim in place leaves beside its file: listing them, discarding one or all,
 * and deleting the ones past their expiry. A backup file is only ever deleted through the row that
 * names it, and only while its size is still the recorded one, so a file the user put in its place
 * is left alone. Discarding and expiry delete Plisto's own hidden copy, never a music file, so
 * neither depends on the trim switch.
 */

// -- Library Imports --
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

// -- Local Imports --
use super::recover::{file_name_only, reach_check, remove, sweep_pending, sweep_place};
use super::trim::{open_write_conn, TrimFailure};
use crate::commands::file_writes::UNFINISHED_WRITES;
use crate::commands::now_unix;
use crate::db;
use crate::db::file_writes::{
    delete_undo, expired_backups, kept_backups, undo_row, undo_targeted, UndoRow,
};
use crate::dto::{KeptBackup, KeptDiscardAllOutcome, KeptState};
use crate::scan::file_stats_checked;
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

const TURN_EVERY: Duration = Duration::from_secs(3_600);

/// Where one kept backup's folder is, as the index knows it now.
pub struct Place {
    /// The folder the row is filed under, for its label.
    root: PathBuf,
    /// What reachability is asked of: a live root itself, and for a removed root only its drive, so
    /// a folder that is gone from a present drive reads as missing rather than offline.
    reach_at: PathBuf,
    /// The trimmed file: the track's path while it has one, else the root plus the row's path.
    source: PathBuf,
    /// The folders the backup may sit in, most likely first.
    folders: Vec<PathBuf>,
    live_root: bool,
    live_track: bool,
    /// The scan flagged the track's file as gone.
    track_missing: bool,
    /// Unix seconds.
    kept_at: i64,
}

/// What a backup's file is on disk, against what its row recorded.
enum Backup {
    Gone,
    /// A file of another size sits under the name.
    Altered,
    Intact(PathBuf),
    /// The file system could not say.
    Unreadable,
}

/// The kept backups with their places. The index is read here and nothing else is touched, so the
/// caller can release it before any file is.
pub fn kept_places(conn: &Connection) -> rusqlite::Result<Vec<(UndoRow, Place)>> {
    kept_backups(conn)?
        .into_iter()
        .map(|row| place_of(conn, &row).map(|place| (row, place)))
        .collect()
}

// The folder a sweep would look in comes first (the track's own while it has one), then the live
// root plus the row's folder, then the root path recorded at write time, so a track moved alone
// still finds its backup where the trim left it.
fn place_of(conn: &Connection, row: &UndoRow) -> rusqlite::Result<Place> {
    let kept_at = conn
        .query_row(
            "SELECT started_at FROM file_write_batches WHERE id = ?1",
            params![row.batch_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let track = match row.track_id {
        Some(id) => conn
            .query_row(
                "SELECT COALESCE(display_path, source_path), missing_at IS NOT NULL
                 FROM tracks WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)),
            )
            .optional()?,
        None => None,
    };
    let live = match row.root_id {
        Some(id) => db::root_target(conn, id)?.map(|(_, path)| PathBuf::from(path)),
        None => None,
    };
    let Some((root, primary)) = sweep_place(conn, row)? else {
        return Ok(Place {
            root: PathBuf::new(),
            reach_at: PathBuf::new(),
            source: PathBuf::new(),
            folders: Vec::new(),
            live_root: false,
            live_track: false,
            track_missing: false,
            kept_at,
        });
    };
    let rel_dir = Path::new(&row.rel_path).parent().unwrap_or(Path::new(""));
    let mut folders = vec![primary];
    for base in live.iter().cloned().chain([PathBuf::from(&row.root_path)]) {
        let folder = base.join(rel_dir);
        if !base.as_os_str().is_empty() && !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    let live_track = track.is_some();
    let live_root = live_track || live.is_some();
    Ok(Place {
        reach_at: if live_root {
            root.clone()
        } else {
            volume_of(&root)
        },
        source: match &track {
            Some((file, _)) => PathBuf::from(file),
            None => root.join(&row.rel_path),
        },
        root,
        folders,
        live_root,
        live_track,
        track_missing: track.is_some_and(|(_, missing)| missing),
        kept_at,
    })
}

// The drive or share a path sits on, or the path itself when it names none.
fn volume_of(path: &Path) -> PathBuf {
    let mut parts = path.components();
    match (parts.next(), parts.next()) {
        (Some(prefix @ Component::Prefix(_)), Some(root @ Component::RootDir)) => {
            [prefix, root].into_iter().collect()
        }
        _ => path.to_path_buf(),
    }
}

// The backup's path in `folder`, or None when its name is more than one file name.
fn backup_path(row: &UndoRow, folder: &Path) -> Option<PathBuf> {
    let name = row
        .backup_name
        .as_deref()
        .filter(|name| file_name_only(name))?;
    Some(folder.join(name))
}

// The first folder that holds something under the backup's name decides.
fn inspect(row: &UndoRow, place: &Place) -> Backup {
    for folder in &place.folders {
        let Some(path) = backup_path(row, folder) else {
            return Backup::Gone;
        };
        match fs::metadata(&path) {
            Ok(md) if md.is_file() => {
                return if Some(md.len() as i64) == row.backup_size {
                    Backup::Intact(path)
                } else {
                    Backup::Altered
                };
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Backup::Unreadable,
        }
    }
    Backup::Gone
}

fn root_label(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.to_string_lossy().into_owned())
}

/// The list the Kept backups sheet shows, one stat of the backup and, for a row that could be
/// undone, one of its source. `trim_on` is the trim switch: with it off nothing can be undone.
pub fn describe(
    rows: Vec<(UndoRow, Place)>,
    trim_on: bool,
    mut reachable: impl FnMut(&Path) -> bool,
) -> Vec<KeptBackup> {
    rows.into_iter()
        .map(|(row, place)| {
            let found = reachable(&place.reach_at).then(|| inspect(&row, &place));
            let state = match found {
                None => KeptState::Offline,
                Some(Backup::Gone) => KeptState::Missing,
                Some(_) => KeptState::Kept,
            };
            // The undo looks for the backup beside the track's own file and nowhere else.
            let beside = matches!(&found, Some(Backup::Intact(path))
                if path.parent() == place.source.parent());
            let can_undo = trim_on
                && place.live_root
                && place.live_track
                && !place.track_missing
                && beside
                && file_stats_checked(&place.source).ok() == Some((row.post_size, row.post_mtime));
            KeptBackup {
                undo_id: row.id,
                track_id: row.track_id,
                root_id: row.root_id,
                title: row.title,
                rel_path: row.rel_path,
                root_label: root_label(&place.root),
                size: row.backup_size.unwrap_or(0),
                kept_at: place.kept_at * 1000,
                expires_at: row.expires_at.map(|secs| secs * 1000),
                original_duration_ms: row.pre_duration_ms,
                trimmed_duration_ms: row.post_duration_ms,
                state,
                can_undo,
            }
        })
        .collect()
}

/// How discarding one backup ended.
enum Discarded {
    /// The file and its row are gone, or the file was already.
    Removed,
    /// The file changed since it was kept: its row went and it stayed.
    LeftInPlace,
    /// The file could not be deleted or read; the row stays.
    Kept,
    /// A journal row still targets the backup; nothing is touched.
    Pending,
}

fn discard_row(conn: &Connection, row: &UndoRow, place: &Place) -> rusqlite::Result<Discarded> {
    if undo_targeted(conn, row.id)? {
        return Ok(Discarded::Pending);
    }
    match inspect(row, place) {
        Backup::Gone => delete_undo(conn, row.id).map(|()| Discarded::Removed),
        Backup::Altered => delete_undo(conn, row.id).map(|()| Discarded::LeftInPlace),
        Backup::Intact(path) if remove(&path) => {
            delete_undo(conn, row.id).map(|()| Discarded::Removed)
        }
        Backup::Intact(_) | Backup::Unreadable => Ok(Discarded::Kept),
    }
}

/// Discards one kept backup and returns whether its file was left in place. An unknown or already
/// discarded row is nothing to do. The caller holds the user lock and has checked no write runs.
pub fn discard(
    conn: &Connection,
    undo_id: i64,
    mut reachable: impl FnMut(&Path) -> bool,
) -> Result<bool, String> {
    let db_err = |e: rusqlite::Error| TrimFailure::of_db(&e).to_string();
    let Some(row) = undo_row(conn, undo_id).map_err(db_err)?.filter(is_kept) else {
        return Ok(false);
    };
    let place = place_of(conn, &row).map_err(db_err)?;
    if !reachable(&place.reach_at) {
        return Err(TrimFailure::Offline.to_string());
    }
    match discard_row(conn, &row, &place).map_err(db_err)? {
        Discarded::Removed => Ok(false),
        Discarded::LeftInPlace => Ok(true),
        Discarded::Kept => {
            Err(TrimFailure::Unavailable("the backup cannot be deleted").to_string())
        }
        Discarded::Pending => Err(UNFINISHED_WRITES.to_string()),
    }
}

fn is_kept(row: &UndoRow) -> bool {
    row.kind == "trim" && row.backup_name.is_some() && row.undone_at.is_none()
}

/// Discards every kept backup it can reach. Rows on a folder that does not answer are skipped and
/// counted as offline; one that cannot be deleted, or that an unfinished write still targets, stays
/// and counts as failed; one that changed is left in place.
pub fn discard_all(
    conn: &Connection,
    mut reachable: impl FnMut(&Path) -> bool,
) -> rusqlite::Result<KeptDiscardAllOutcome> {
    let mut out = KeptDiscardAllOutcome::default();
    for (row, place) in kept_places(conn)? {
        if !reachable(&place.reach_at) {
            out.offline += 1;
            continue;
        }
        match discard_row(conn, &row, &place)? {
            Discarded::Removed => out.discarded += 1,
            Discarded::LeftInPlace => {
                out.discarded += 1;
                out.left_in_place += 1;
            }
            Discarded::Kept | Discarded::Pending => out.failed += 1,
        }
    }
    Ok(out)
}

/// Deletes the backups whose expiry has passed at `now` (Unix seconds) and returns how many rows
/// went. A root that does not answer keeps its rows and files, and so does a file whose size is no
/// longer the recorded one or that an unfinished write still targets; a file already gone drops its
/// row. It stops before the next row once `stopped` answers true.
pub fn expire(
    conn: &Connection,
    now: i64,
    mut reachable: impl FnMut(&Path) -> bool,
    stopped: impl Fn() -> bool,
) -> rusqlite::Result<usize> {
    let mut removed = 0;
    for row in expired_backups(conn, now)? {
        if stopped() {
            break;
        }
        let place = place_of(conn, &row)?;
        if !reachable(&place.reach_at) || undo_targeted(conn, row.id)? {
            continue;
        }
        let drop_row = match inspect(&row, &place) {
            Backup::Gone => true,
            Backup::Intact(path) => remove(&path),
            Backup::Altered | Backup::Unreadable => false,
        };
        if drop_row {
            delete_undo(conn, row.id)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// One hourly turn: expiry, then the sweep of what committed writes left. Skipped without a word
/// while a file write runs or another job holds the scan lock; returns whether it ran. It reads and
/// writes through a connection of its own, so the shared index is never held across file work. A
/// user taker raising the background cancel flag ends the turn between rows and between its steps.
pub fn hourly_turn(state: &AppState, now: i64, mut reachable: impl FnMut(&Path) -> bool) -> bool {
    if state.file_write_running.load(Ordering::SeqCst) {
        return false;
    }
    let Ok(_lock) = acquire_scan_lock(state, Holder::Background) else {
        return false;
    };
    let Ok(conn) = open_write_conn(&state.db_path) else {
        return false;
    };
    // This turn is the only background holder, so a flag left by an earlier taker is stale.
    state.bg_cancel.store(false, Ordering::SeqCst);
    let stopped = || state.bg_cancel.load(Ordering::SeqCst);
    if let Err(e) = expire(&conn, now, &mut reachable, stopped) {
        eprintln!("[file_writes] cannot expire kept backups: {e}");
    }
    if stopped() {
        return true;
    }
    if let Err(e) = sweep_pending(&conn, &mut reachable) {
        eprintln!("[file_writes] cannot sweep: {e}");
    }
    true
}

/// Starts the hourly turn for the life of the app.
pub fn spawn(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("kept-backups".to_string())
        .spawn(move || loop {
            std::thread::sleep(TURN_EVERY);
            hourly_turn(&app.state::<AppState>(), now_unix(), reach_check());
        });
}

#[cfg(test)]
mod guard_tests;
#[cfg(test)]
mod place_tests;
#[cfg(test)]
mod tests;
