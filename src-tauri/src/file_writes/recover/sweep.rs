/*
 * The sweep of what committed writes left behind: the files an undo row lists for deletion are
 * deleted from its folder, each only while its size still matches, and a kept backup never is.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

// -- Local Imports --
use crate::db;
use crate::db::file_writes::{clear_sweep, kept_backups, sweep_rows, UndoRow};

/// Deletes the files committed writes listed for deletion, then clears them from their rows. A file
/// is deleted only while its size matches; one already gone is cleared, one that differs stays
/// listed. A row whose root is unreachable or whose folder is gone is skipped, and a kept backup is
/// never deleted.
pub fn sweep_pending(
    conn: &Connection,
    mut reachable: impl FnMut(&Path) -> bool,
) -> rusqlite::Result<()> {
    for row in sweep_rows(conn)? {
        let Some((root, folder)) = sweep_place(conn, &row)? else {
            continue;
        };
        if !reachable(&root) || !folder.is_dir() {
            continue;
        }
        sweep_row(conn, &row, &folder)?;
    }
    Ok(())
}

/// Deletes the files one undo row lists in `folder`, as `sweep_pending` does for each row.
pub(in crate::file_writes) fn sweep_row(
    conn: &Connection,
    row: &UndoRow,
    folder: &Path,
) -> rusqlite::Result<()> {
    let kept: HashSet<String> = kept_backups(conn)?
        .into_iter()
        .filter_map(|row| row.backup_name)
        .collect();
    let mut settled = Vec::new();
    for entry in row.sweep.iter().filter(|e| !kept.contains(&e.name)) {
        let path = folder.join(&entry.name);
        let gone = match fs::metadata(&path) {
            Err(e) => e.kind() == io::ErrorKind::NotFound,
            Ok(md) => {
                md.is_file() && md.len() as i64 == entry.size && fs::remove_file(&path).is_ok()
            }
        };
        if gone {
            settled.push(entry.name.clone());
        }
    }
    if !settled.is_empty() {
        clear_sweep(conn, row.id, &settled)?;
    }
    Ok(())
}

// The root and folder an undo row's files sit in: the track's current folder while it has one,
// then the live root plus `rel_path`, then the root path recorded at write time. None when nothing
// is left.
pub(in crate::file_writes) fn sweep_place(
    conn: &Connection,
    row: &UndoRow,
) -> rusqlite::Result<Option<(PathBuf, PathBuf)>> {
    if let Some(track_id) = row.track_id {
        let found = conn
            .query_row(
                "SELECT COALESCE(t.display_path, t.source_path), r.path
                 FROM tracks t JOIN roots r ON r.id = t.root_id WHERE t.id = ?1",
                params![track_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((file, root)) = found {
            if let Some(folder) = Path::new(&file).parent() {
                return Ok(Some((PathBuf::from(root), folder.to_path_buf())));
            }
        }
    }
    let rel_dir = Path::new(&row.rel_path).parent().unwrap_or(Path::new(""));
    let live = match row.root_id {
        Some(id) => db::root_target(conn, id)?.map(|(_, path)| path),
        None => None,
    };
    let root = match live {
        Some(path) => PathBuf::from(path),
        None if row.root_path.is_empty() => return Ok(None),
        None => PathBuf::from(&row.root_path),
    };
    let folder = root.join(rel_dir);
    Ok(Some((root, folder)))
}
