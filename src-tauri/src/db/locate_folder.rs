/*
 * The locate writer for a folder inside a root: points the gone tracks under one folder at the files
 * found under the folder they now live in, in the same root or another. A found track keeps its id,
 * and with it every edit, membership, playlist slot and play: with no row at its new path it is
 * re-pointed there, and a row a scan already added there folds into it. Matching is exact: the same
 * path below the folder and the indexed size, mtime ignored. The caller stats the files; the writer
 * plans again from what was found inside its own transaction, so a library change since the plan is
 * never written over, and any failure rolls the whole write back.
 */

// -- Library Imports --
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

// -- Local Imports --
use super::duplicates::member_count;
use super::folder_moves::{record_folder_move, FolderMove};
use super::playlist_albums::{dissolve_entries_into, referenced_album_members};
use super::relocate::{path_key, predict_emptied, rebase, rewrite_track, RelRow};
use super::relocate_fold::{fold_pairs, set_scan_values};
use super::{all_folder_cover_paths, get_folder_cover, membership_album, root_targets};
use crate::normalize::{folder_of, normalize_path_key};
use crate::paths::relative_under;

/// Why a folder locate was refused or failed. Nothing is written in any case.
#[derive(Debug)]
pub enum LocateFolderError {
    Sql(rusqlite::Error),
    RootGone,
    /// A gone track's real-case path is not under the folder its key is under.
    OutOfPrefix { track_id: i64 },
    /// No gone track of the root sits at or under the folder.
    NothingGone,
    /// The new folder is the gone folder.
    Same,
    /// One folder holds the other, so a new path could land on a track being moved.
    Overlap,
    /// The new folder is in no root of the library.
    OutsideRoots,
    /// No gone track's file was found under the new folder at its indexed size.
    NoMatch,
}

impl LocateFolderError {
    /// The refusal's code; None for a failure.
    pub fn refusal(&self) -> Option<&'static str> {
        match self {
            LocateFolderError::NothingGone => Some("nothing_gone"),
            LocateFolderError::Same => Some("same"),
            LocateFolderError::Overlap => Some("overlap"),
            LocateFolderError::OutsideRoots => Some("outside_roots"),
            LocateFolderError::NoMatch => Some("no_match"),
            LocateFolderError::Sql(_)
            | LocateFolderError::RootGone
            | LocateFolderError::OutOfPrefix { .. } => None,
        }
    }
}

impl std::fmt::Display for LocateFolderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocateFolderError::Sql(e) => write!(f, "{e}"),
            LocateFolderError::RootGone => write!(f, "the folder is no longer in the library"),
            LocateFolderError::OutOfPrefix { track_id } => {
                write!(f, "track {track_id} is stored outside its folder")
            }
            LocateFolderError::NothingGone => write!(f, "no gone track is in that folder"),
            LocateFolderError::Same => write!(f, "the new folder is the gone folder"),
            LocateFolderError::Overlap => write!(f, "one folder is inside the other"),
            LocateFolderError::OutsideRoots => write!(f, "the new folder is in no library folder"),
            LocateFolderError::NoMatch => write!(f, "no gone file was found in the new folder"),
        }
    }
}

impl From<rusqlite::Error> for LocateFolderError {
    fn from(e: rusqlite::Error) -> Self {
        LocateFolderError::Sql(e)
    }
}

/// A gone track's file as the new folder would hold it: the real-case `path` to stat, its folded
/// `key` for the found map, and the size the track was indexed at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocateTarget {
    pub track_id: i64,
    pub path: String,
    pub key: String,
    pub size_bytes: i64,
}

/// What a folder locate writes, for the gone tracks at or under `folder` of `root_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocateFolderPlan {
    pub root_id: i64,
    pub folder: String,
    pub new_path: String,
    /// The root holding `new_path`; every found track ends up under it.
    pub target_root_id: i64,
    /// Found tracks with no row at their new path, re-pointed there.
    pub relinked: Vec<i64>,
    /// (gone track, row at its new path) pairs. The row folds into the gone track.
    pub merged: Vec<(i64, i64)>,
    /// Gone tracks whose file was not found, or found at another size. They stay gone.
    pub stays: Vec<i64>,
    /// Albums every member of which leaves for a filed gone twin.
    pub albums_replaced: i64,
    // The found files the plan rests on, folded key to size.
    found: HashMap<String, i64>,
}

/// What a folder locate wrote.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocateFolderReport {
    pub relinked: i64,
    pub merged: i64,
    pub stays: i64,
    pub albums_replaced: i64,
}

/// Where each gone track at or under `folder` would sit under `new_path`, for the caller to stat.
/// Refused as `plan_locate_folder` refuses. Read-only.
pub fn locate_targets(
    conn: &Connection,
    root_id: i64,
    folder: &str,
    new_path: &str,
) -> Result<Vec<LocateTarget>, LocateFolderError> {
    let batch = read_batch(conn, root_id, folder, new_path)?;
    Ok(batch
        .gone
        .into_iter()
        .map(|g| LocateTarget {
            track_id: g.row.id,
            path: g.path,
            key: g.key,
            size_bytes: g.size_bytes,
        })
        .collect())
}

/// How locating `folder` of `root_id` at `new_path` would go, given `found`: the folded key of each
/// file found under `new_path` to its size on disk. A gone track is found when its file sits at the
/// same place below the new folder at the size it was indexed at. Read-only.
pub fn plan_locate_folder(
    conn: &Connection,
    root_id: i64,
    folder: &str,
    new_path: &str,
    found: &HashMap<String, i64>,
) -> Result<LocateFolderPlan, LocateFolderError> {
    let batch = read_batch(conn, root_id, folder, new_path)?;
    let sorted = sort_batch(conn, &batch, found)?;
    Ok(LocateFolderPlan {
        root_id,
        folder: folder.to_string(),
        new_path: new_path.to_string(),
        target_root_id: batch.target_root_id,
        albums_replaced: predict_emptied(conn, &sorted.merged)?,
        relinked: sorted.relinked,
        merged: sorted.merged,
        stays: sorted.stays,
        found: sorted.found,
    })
}

/// Applies `plan` in one transaction, planned again against the library as it is now from the files
/// the plan found. Each pair folds onto the gone track, which takes the row's scan columns; each
/// relinked track is re-pointed. Every found track moves to the target root and reads present. An
/// album the fold empties is deleted, and a playlist entry of it becomes the tracks its members folded
/// onto. Folder covers follow, and the move is recorded.
pub fn locate_folder(
    conn: &mut Connection,
    plan: &LocateFolderPlan,
    now: i64,
) -> Result<LocateFolderReport, LocateFolderError> {
    let tx = conn.transaction()?;
    let batch = read_batch(&tx, plan.root_id, &plan.folder, &plan.new_path)?;
    let sorted = sort_batch(&tx, &batch, &plan.found)?;
    // Read before the fold empties any album, while every member is still in its place.
    let referenced = referenced_album_members(&tx)?;
    let mut left = BTreeSet::new();
    for &(_, n) in &sorted.merged {
        if let Some(album_id) = membership_album(&tx, n)? {
            left.insert(album_id);
        }
    }

    let scans = fold_pairs(&tx, &sorted.merged, now)?;
    for (t, values) in &scans {
        set_scan_values(&tx, *t, values)?;
    }
    // The root goes first: rewrite_track stamps a moved issue with its track's root.
    let found_ids = sorted
        .relinked
        .iter()
        .copied()
        .chain(sorted.merged.iter().map(|&(t, _)| t));
    {
        let mut restamp =
            tx.prepare("UPDATE tracks SET root_id = ?1, missing_at = NULL WHERE id = ?2")?;
        for id in found_ids {
            restamp.execute(params![batch.target_root_id, id])?;
        }
    }
    let new_root = Path::new(&plan.new_path);
    let relinked: HashSet<i64> = sorted.relinked.iter().copied().collect();
    for g in batch.gone.iter().filter(|g| relinked.contains(&g.row.id)) {
        rewrite_track(&tx, &g.row, new_root)?;
    }

    // An album the fold emptied lives on as the gone tracks, so its playlist entries become them.
    let twin: HashMap<i64, i64> = sorted.merged.iter().map(|&(t, n)| (n, t)).collect();
    for (album_id, members) in &referenced {
        if left.contains(album_id) && member_count(&tx, *album_id)? == 0 {
            let kept: Vec<i64> = members
                .iter()
                .map(|id| twin.get(id).copied().unwrap_or(*id))
                .collect();
            dissolve_entries_into(&tx, *album_id, &kept)?;
        }
    }
    let mut albums_replaced = 0;
    for album_id in left {
        if member_count(&tx, album_id)? == 0 {
            tx.execute("DELETE FROM albums WHERE id = ?1", params![album_id])?;
            albums_replaced += 1;
        }
    }

    let folded: HashSet<i64> = twin.values().copied().collect();
    let found_rels: Vec<&Path> = batch
        .gone
        .iter()
        .filter(|g| relinked.contains(&g.row.id) || folded.contains(&g.row.id))
        .map(|g| g.row.rel_key.as_path())
        .collect();
    move_folder_covers(&tx, &batch.folder_key, new_root, &found_rels)?;
    record_folder_move(
        &tx,
        FolderMove {
            from_root_id: plan.root_id,
            from_rel: batch.from_rel,
            to_root_id: batch.target_root_id,
            to_rel: batch.to_rel,
            at: now,
        },
    )?;

    tx.commit()?;
    Ok(LocateFolderReport {
        relinked: sorted.relinked.len() as i64,
        merged: sorted.merged.len() as i64,
        stays: sorted.stays.len() as i64,
        albums_replaced,
    })
}

// ---- Reading and sorting ----

// The gone tracks under a folder, placed under the new folder, with both folders below their roots.
struct Batch {
    target_root_id: i64,
    folder_key: String,
    from_rel: String,
    to_rel: String,
    gone: Vec<Gone>,
}

// A gone track's place below the folder and its file's place under the new folder.
struct Gone {
    row: RelRow,
    size_bytes: i64,
    path: String,
    key: String,
}

struct Sorted {
    relinked: Vec<i64>,
    merged: Vec<(i64, i64)>,
    stays: Vec<i64>,
    found: HashMap<String, i64>,
}

/// Reads the gone tracks at or under `folder` and places each under `new_path`. Refused, in order,
/// when the root is gone, the folder holds no gone track of it, the folders are the same or nested,
/// or `new_path` is in no root.
fn read_batch(
    conn: &Connection,
    root_id: i64,
    folder: &str,
    new_path: &str,
) -> Result<Batch, LocateFolderError> {
    let root: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT path, root_key FROM roots WHERE id = ?1",
            params![root_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (root_path, root_key) = root.ok_or(LocateFolderError::RootGone)?;
    let root_key = root_key.unwrap_or_else(|| normalize_path_key(&root_path));
    let folder_key = normalize_path_key(folder);
    let from_rel = relative_under(Path::new(&folder_key), Path::new(&root_key))
        .ok_or(LocateFolderError::NothingGone)?;
    let gone = gone_under(conn, root_id, folder, &folder_key)?;
    if gone.is_empty() {
        return Err(LocateFolderError::NothingGone);
    }

    // Nested folders would let a new path land on the old path of another track in the batch.
    let new_root = Path::new(new_path);
    match relative_under(new_root, Path::new(&folder_key)) {
        Some(rest) if rest.as_os_str().is_empty() => return Err(LocateFolderError::Same),
        Some(_) => return Err(LocateFolderError::Overlap),
        None if relative_under(Path::new(folder), new_root).is_some() => {
            return Err(LocateFolderError::Overlap)
        }
        None => {}
    }
    let (target_root_id, to_rel) =
        containing_root(conn, new_path)?.ok_or(LocateFolderError::OutsideRoots)?;

    let gone = gone
        .into_iter()
        .map(|(row, size_bytes)| Gone {
            key: path_key(&rebase(new_root, &row.rel_key)),
            path: rebase(new_root, &row.rel_disp)
                .to_string_lossy()
                .into_owned(),
            row,
            size_bytes,
        })
        .collect();
    Ok(Batch {
        target_root_id,
        folder_key,
        from_rel: path_key(&from_rel),
        to_rel: path_key(&to_rel),
        gone,
    })
}

/// Every gone track of `root_id` whose key is at or under `folder_key`, with its size. Refused when
/// one's real-case path is not under `folder`.
fn gone_under(
    conn: &Connection,
    root_id: i64,
    folder: &str,
    folder_key: &str,
) -> Result<Vec<(RelRow, i64)>, LocateFolderError> {
    let mut stmt = conn.prepare(
        "SELECT id, source_path, display_path, size_bytes FROM tracks
         WHERE root_id = ?1 AND missing_at IS NOT NULL ORDER BY id",
    )?;
    let rows = stmt
        .query_map(params![root_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut gone = Vec::new();
    for (id, key, display, size_bytes) in rows {
        let Some(rel_key) = relative_under(Path::new(&key), Path::new(folder_key)) else {
            continue;
        };
        let disp = display.as_deref().unwrap_or(&key);
        let rel_disp = relative_under(Path::new(disp), Path::new(folder))
            .ok_or(LocateFolderError::OutOfPrefix { track_id: id })?;
        gone.push((
            RelRow {
                id,
                rel_key,
                rel_disp,
            },
            size_bytes,
        ));
    }
    Ok(gone)
}

/// The root holding `path` and the remainder of `path` below it; the deepest root when roots nest.
fn containing_root(conn: &Connection, path: &str) -> rusqlite::Result<Option<(i64, PathBuf)>> {
    Ok(root_targets(conn)?
        .into_iter()
        .filter_map(|(id, root)| relative_under(Path::new(path), Path::new(&root)).map(|rest| (id, rest)))
        .min_by_key(|(_, rest)| rest.components().count()))
}

/// Sorts each gone track by what the new folder holds for it: no file of its size, a file with no
/// row, or a file a row already holds. Refused when nothing is found.
fn sort_batch(
    conn: &Connection,
    batch: &Batch,
    found: &HashMap<String, i64>,
) -> Result<Sorted, LocateFolderError> {
    let mut sorted = Sorted {
        relinked: Vec::new(),
        merged: Vec::new(),
        stays: Vec::new(),
        found: HashMap::new(),
    };
    let mut at_key = conn.prepare("SELECT id FROM tracks WHERE source_path = ?1")?;
    for g in &batch.gone {
        if found.get(&g.key) != Some(&g.size_bytes) {
            sorted.stays.push(g.row.id);
            continue;
        }
        sorted.found.insert(g.key.clone(), g.size_bytes);
        match at_key
            .query_row(params![g.key], |r| r.get::<_, i64>(0))
            .optional()?
        {
            Some(n) => sorted.merged.push((g.row.id, n)),
            None => sorted.relinked.push(g.row.id),
        }
    }
    if sorted.relinked.is_empty() && sorted.merged.is_empty() {
        return Err(LocateFolderError::NoMatch);
    }
    Ok(sorted)
}

// ---- Folder covers ----

/// Moves each folder cover at or under `folder_key` to the same place under `new_root` when a found
/// track sat at or under its folder and no present track still sits directly in it. `found_rels` are
/// the found tracks' folded places below `folder_key`. A cover already bound at the new place is kept,
/// and the old one stays where it is.
fn move_folder_covers(
    conn: &Connection,
    folder_key: &str,
    new_root: &Path,
    found_rels: &[&Path],
) -> rusqlite::Result<()> {
    let covered: Vec<(String, PathBuf)> = all_folder_cover_paths(conn)?
        .into_iter()
        .filter_map(|f| relative_under(Path::new(&f), Path::new(folder_key)).map(|rel| (f, rel)))
        .filter(|(_, rel)| found_rels.iter().any(|found| found.starts_with(rel)))
        .collect();
    if covered.is_empty() {
        return Ok(());
    }
    let present: HashSet<String> = conn
        .prepare("SELECT source_path FROM tracks WHERE missing_at IS NULL")?
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|key| key.map(|key| folder_of(&key)))
        .collect::<rusqlite::Result<_>>()?;
    for (folder, rel) in covered {
        if present.contains(&folder) {
            continue;
        }
        let new_key = path_key(&rebase(new_root, &rel));
        if get_folder_cover(conn, &new_key)?.is_some() {
            continue;
        }
        conn.execute(
            "UPDATE folder_covers SET folder_path = ?1 WHERE folder_path = ?2",
            params![new_key, folder],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
