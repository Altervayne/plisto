/*
 * The relocate writer: points a root at the folder its files now live in, or folds a root that was
 * added at the new location back into the original one. Every user attachment hangs off a track id,
 * so a move is a path rewrite that keeps every id. Every track passes the root-prefix check before
 * the first write, and any failure rolls the whole transaction back. New keys are built in Rust with
 * normalize_path_key, so they equal what the next walk of the new folder produces.
 */

// -- Library Imports --
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

// -- Local Imports --
use super::duplicates::{
    insert_membership, insert_pairs, list_duplicate_dismissals, member_count, membership_row,
    repoint, PLAYS, SLOTS,
};
use super::tag_albums::set_updated_at;
use super::{
    all_folder_cover_paths, delete_emptied_albums, get_setting, membership_album,
    remove_membership, set_setting,
};
use crate::dto::{DismissedPair, MergeMembership};
use crate::normalize::normalize_path_key;
use crate::paths::relative_under;

// The settings key holding every moved root's earlier paths, as JSON.
const ROOT_MOVES: &str = "root_moves";
const MAX_EARLIER: usize = 4;

// The columns a scan writes. A kept track paired with an absorbed one takes these from it, since the
// absorbed row is the fresh read of the same file.
const SCAN_COLUMNS: &[&str] = &[
    "source_path",
    "display_path",
    "filename",
    "ext",
    "size_bytes",
    "mtime",
    "duration_secs",
    "raw_title",
    "raw_artist",
    "raw_album",
    "raw_album_artist",
    "raw_track_no",
    "raw_disc_no",
    "raw_year",
    "raw_genre",
    "has_embedded_cover",
    "scanned_at",
    "missing_at",
];

const EDIT_COLUMNS: &[&str] = &[
    "title",
    "artist",
    "album",
    "album_artist",
    "year",
    "disc_no",
];

/// Why a relocate was refused. Nothing is written in any case.
#[derive(Debug)]
pub enum RelocateError {
    Sql(rusqlite::Error),
    RootGone,
    // A track's stored path is not under its root's path, so its new path cannot be derived.
    OutOfPrefix { track_id: i64 },
    // A track still points at the absorbed root once its rows were carried over.
    AbsorbNotEmpty,
    SameRoot,
}

impl std::fmt::Display for RelocateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelocateError::Sql(e) => write!(f, "{e}"),
            RelocateError::RootGone => write!(f, "the folder is no longer in the library"),
            RelocateError::OutOfPrefix { track_id } => {
                write!(f, "track {track_id} is stored outside its folder")
            }
            RelocateError::AbsorbNotEmpty => {
                write!(f, "tracks still point at the folder being merged")
            }
            RelocateError::SameRoot => write!(f, "a folder cannot merge into itself"),
        }
    }
}

impl From<rusqlite::Error> for RelocateError {
    fn from(e: rusqlite::Error) -> Self {
        RelocateError::Sql(e)
    }
}

/// One track of a root as a relocate reads it: its folded key, real-case path (None on a legacy row),
/// size, and whether its file is flagged gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootTrackPath {
    pub id: i64,
    pub source_path: String,
    pub display_path: Option<String>,
    pub size_bytes: i64,
    pub missing: bool,
}

/// How a merge pairs two roots' tracks: `pairs` as (kept, absorbed) ids, the tracks found on one side
/// only, and how many albums the merge empties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergePlan {
    pub pairs: Vec<(i64, i64)>,
    pub absorb_only: Vec<i64>,
    pub keep_only: Vec<i64>,
    pub albums_emptied: i64,
}

/// What a relocate wrote: tracks rewritten to the new folder, pairs folded together, absorbed-only
/// tracks carried onto the kept root, and albums deleted for having no member left.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelocateReport {
    pub moved: i64,
    pub merged: i64,
    pub carried: i64,
    pub albums_emptied: i64,
}

/// A root's current path and the paths it held before, most recent first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootMove {
    pub root_id: i64,
    pub path: String,
    pub earlier: Vec<String>,
}

/// Every track of `root_id`, ordered by id. Read-only.
pub fn root_track_paths(conn: &Connection, root_id: i64) -> rusqlite::Result<Vec<RootTrackPath>> {
    let mut stmt = conn.prepare(
        "SELECT id, source_path, display_path, size_bytes, missing_at IS NOT NULL
         FROM tracks WHERE root_id = ?1 ORDER BY id",
    )?;
    let rows = stmt
        .query_map(params![root_id], |r| {
            Ok(RootTrackPath {
                id: r.get(0)?,
                source_path: r.get(1)?,
                display_path: r.get(2)?,
                size_bytes: r.get(3)?,
                missing: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Points `root_id` at `new_path` in one transaction, keeping every track id: each track's key and
/// display path, the root row, its folder covers and its recorded earlier paths are rewritten. A
/// case-only move leaves every key equal and changes display values only.
pub fn move_root(
    conn: &mut Connection,
    root_id: i64,
    new_path: &str,
) -> Result<RelocateReport, RelocateError> {
    let tx = conn.transaction()?;
    let (root, rows) = read_side(&tx, root_id)?;
    let new_root = Path::new(new_path);

    for row in &rows {
        rewrite_track(&tx, row, new_root)?;
    }
    tx.execute(
        "UPDATE roots SET path = ?1, root_key = ?2 WHERE id = ?3",
        params![new_path, normalize_path_key(new_path), root_id],
    )?;
    rebase_folder_covers(&tx, &root.key, new_root)?;
    record_move(&tx, root_id, &root.path, new_path, None)?;

    tx.commit()?;
    Ok(RelocateReport {
        moved: rows.len() as i64,
        ..RelocateReport::default()
    })
}

/// How folding `absorb_root` into `keep_root` would go. Tracks pair by equal folded path below their
/// roots. An absorbed track leaves its album when its kept twin is filed, and `albums_emptied`
/// counts the albums every member leaves. Read-only.
pub fn plan_merge(
    conn: &Connection,
    keep_root: i64,
    absorb_root: i64,
) -> Result<MergePlan, RelocateError> {
    let (_, keep) = read_side(conn, keep_root)?;
    let (_, absorb) = read_side(conn, absorb_root)?;
    Ok(plan_rows(conn, &keep, &absorb)?)
}

/// Folds `absorb_root` into `keep_root` in one transaction, after which the kept root lives at the
/// absorbed root's path. Each pair folds onto the kept track: its user data wins and the absorbed
/// track fills the gaps, plays and playlist slots union onto it, and it takes the absorbed track's
/// scan columns. Absorbed-only tracks move to the kept root with their ids. Kept-only tracks are
/// rewritten to the new path. Albums left with no member are deleted and counted.
pub fn merge_root(
    conn: &mut Connection,
    keep_root: i64,
    absorb_root: i64,
    now: i64,
) -> Result<RelocateReport, RelocateError> {
    if keep_root == absorb_root {
        return Err(RelocateError::SameRoot);
    }
    let tx = conn.transaction()?;
    let (keep, keep_rows) = read_side(&tx, keep_root)?;
    let (absorb, absorb_rows) = read_side(&tx, absorb_root)?;
    let plan = plan_rows(&tx, &keep_rows, &absorb_rows)?;

    carry_dismissals(&tx, &plan.pairs, now)?;
    let mut scans = Vec::with_capacity(plan.pairs.len());
    for &(o, n) in &plan.pairs {
        carry_track(&tx, o, n, now)?;
        scans.push((o, scan_values(&tx, n)?));
        tx.execute("DELETE FROM tracks WHERE id = ?1", params![n])?;
    }

    // Re-stamp before the root row goes: deleting it cascades to every track still pointing at it.
    let carried = tx.execute(
        "UPDATE tracks SET root_id = ?1 WHERE root_id = ?2",
        params![keep.id, absorb.id],
    )? as i64;
    let left: i64 = tx.query_row(
        "SELECT COUNT(*) FROM tracks WHERE root_id = ?1",
        params![absorb.id],
        |r| r.get(0),
    )?;
    if left > 0 {
        return Err(RelocateError::AbsorbNotEmpty);
    }
    tx.execute("DELETE FROM roots WHERE id = ?1", params![absorb.id])?;
    tx.execute(
        "UPDATE roots SET path = ?1, root_key = ?2 WHERE id = ?3",
        params![absorb.path, absorb.key, keep.id],
    )?;

    for (o, values) in &scans {
        set_scan_values(&tx, *o, values)?;
    }
    let new_root = Path::new(&absorb.path);
    let paired: HashSet<i64> = plan.pairs.iter().map(|&(o, _)| o).collect();
    for row in keep_rows.iter().filter(|r| !paired.contains(&r.id)) {
        rewrite_track(&tx, row, new_root)?;
    }
    rebase_folder_covers(&tx, &keep.key, new_root)?;
    record_move(&tx, keep.id, &keep.path, &absorb.path, Some(absorb.id))?;
    let albums_emptied = delete_emptied_albums(&tx)? as i64;

    tx.commit()?;
    Ok(RelocateReport {
        moved: plan.keep_only.len() as i64,
        merged: plan.pairs.len() as i64,
        carried,
        albums_emptied,
    })
}

/// Copies the whole database to `dest` through a sibling `.tmp` file, so an earlier copy is replaced
/// only once the new one is complete.
pub fn backup_to(conn: &Connection, dest: &Path) -> rusqlite::Result<()> {
    let tmp = dest.with_extension("tmp");
    // VACUUM INTO refuses an existing file, so a leftover from a failed run goes first.
    match std::fs::remove_file(&tmp) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(io_failure(e)),
        _ => {}
    }
    conn.execute(
        "VACUUM INTO ?1",
        params![tmp.to_string_lossy().into_owned()],
    )?;
    std::fs::rename(&tmp, dest).map_err(io_failure)
}

/// Every root's recorded earlier paths, ordered by root id. An absent or unreadable value reads as
/// none.
pub fn root_moves(conn: &Connection) -> rusqlite::Result<Vec<RootMove>> {
    Ok(get_setting(conn, ROOT_MOVES)?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default())
}

/// Drops `root_id`'s recorded earlier paths, if it has any.
pub(super) fn forget_root_moves(conn: &Connection, root_id: i64) -> rusqlite::Result<()> {
    let mut moves = root_moves(conn)?;
    if take_move(&mut moves, root_id).is_some() {
        write_moves(conn, moves)?;
    }
    Ok(())
}

// ---- Reading and placing ----

struct RootRow {
    id: i64,
    path: String,
    key: String,
}

// One track's place under its root: the folded remainder of its key and the real-case remainder of
// its display path.
struct RelRow {
    id: i64,
    rel_key: PathBuf,
    rel_disp: PathBuf,
}

/// Reads a root and places each of its tracks under it. Refused when the root is gone or any track
/// sits outside its path.
fn read_side(conn: &Connection, root_id: i64) -> Result<(RootRow, Vec<RelRow>), RelocateError> {
    let found: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT path, root_key FROM roots WHERE id = ?1",
            params![root_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (path, key) = found.ok_or(RelocateError::RootGone)?;
    // A root not yet keyed folds its path the way the load-time fill does.
    let key = key.unwrap_or_else(|| normalize_path_key(&path));
    let root = RootRow {
        id: root_id,
        path,
        key,
    };

    let rows = root_track_paths(conn, root_id)?
        .into_iter()
        .map(|row| {
            let disp = row.display_path.as_deref().unwrap_or(&row.source_path);
            let rel_key = relative_under(Path::new(&row.source_path), Path::new(&root.key));
            let rel_disp = relative_under(Path::new(disp), Path::new(&root.path));
            match (rel_key, rel_disp) {
                (Some(rel_key), Some(rel_disp)) => Ok(RelRow {
                    id: row.id,
                    rel_key,
                    rel_disp,
                }),
                _ => Err(RelocateError::OutOfPrefix { track_id: row.id }),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((root, rows))
}

fn plan_rows(conn: &Connection, keep: &[RelRow], absorb: &[RelRow]) -> rusqlite::Result<MergePlan> {
    let by_key: HashMap<String, i64> = keep.iter().map(|r| (path_key(&r.rel_key), r.id)).collect();
    let mut pairs = Vec::new();
    let mut absorb_only = Vec::new();
    for n in absorb {
        match by_key.get(&path_key(&n.rel_key)) {
            Some(&o) => pairs.push((o, n.id)),
            None => absorb_only.push(n.id),
        }
    }
    pairs.sort_unstable();
    let paired: HashSet<i64> = pairs.iter().map(|&(o, _)| o).collect();
    let keep_only = keep
        .iter()
        .map(|r| r.id)
        .filter(|id| !paired.contains(id))
        .collect();
    let albums_emptied = predict_emptied(conn, &pairs)?;
    Ok(MergePlan {
        pairs,
        absorb_only,
        keep_only,
        albums_emptied,
    })
}

fn predict_emptied(conn: &Connection, pairs: &[(i64, i64)]) -> rusqlite::Result<i64> {
    let mut leaving: BTreeMap<i64, i64> = BTreeMap::new();
    for &(o, n) in pairs {
        if let Some(album_id) = membership_album(conn, n)? {
            if membership_album(conn, o)?.is_some() {
                *leaving.entry(album_id).or_default() += 1;
            }
        }
    }
    let mut emptied = 0;
    for (&album_id, &count) in &leaving {
        if member_count(conn, album_id)? == count {
            emptied += 1;
        }
    }
    Ok(emptied)
}

// ---- Path rewrites ----

/// `rel` re-anchored at `root`. An empty remainder is the root itself, which `join` would suffix with
/// a separator.
fn rebase(root: &Path, rel: &Path) -> PathBuf {
    if rel.as_os_str().is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    }
}

fn path_key(path: &Path) -> String {
    normalize_path_key(&path.to_string_lossy())
}

fn rewrite_track(conn: &Connection, row: &RelRow, new_root: &Path) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE tracks SET source_path = ?1, display_path = ?2 WHERE id = ?3",
        params![
            path_key(&rebase(new_root, &row.rel_key)),
            rebase(new_root, &row.rel_disp)
                .to_string_lossy()
                .into_owned(),
            row.id
        ],
    )?;
    Ok(())
}

/// Re-keys every folder cover under `old_key` to the same folder under `new_root`. A cover already
/// bound at the new key gives way: the rewritten root's own choice wins.
fn rebase_folder_covers(conn: &Connection, old_key: &str, new_root: &Path) -> rusqlite::Result<()> {
    for folder in all_folder_cover_paths(conn)? {
        let Some(rel) = relative_under(Path::new(&folder), Path::new(old_key)) else {
            continue;
        };
        let new_key = path_key(&rebase(new_root, &rel));
        if new_key == folder {
            continue;
        }
        conn.execute(
            "DELETE FROM folder_covers WHERE folder_path = ?1",
            params![new_key],
        )?;
        conn.execute(
            "UPDATE folder_covers SET folder_path = ?1 WHERE folder_path = ?2",
            params![new_key, folder],
        )?;
    }
    Ok(())
}

// ---- Merge carry-over ----

/// Moves every dismissal that names an absorbed track onto its kept twin. The pair of twins itself
/// drops out, and the old rows cascade away with the absorbed tracks.
fn carry_dismissals(conn: &Connection, pairs: &[(i64, i64)], now: i64) -> rusqlite::Result<()> {
    let twin: HashMap<i64, i64> = pairs.iter().map(|&(o, n)| (n, o)).collect();
    let mut carried = Vec::new();
    for pair in list_duplicate_dismissals(conn)? {
        if !twin.contains_key(&pair.track_lo) && !twin.contains_key(&pair.track_hi) {
            continue;
        }
        let a = twin.get(&pair.track_lo).copied().unwrap_or(pair.track_lo);
        let b = twin.get(&pair.track_hi).copied().unwrap_or(pair.track_hi);
        if a != b {
            carried.push(DismissedPair {
                track_lo: a.min(b),
                track_hi: a.max(b),
            });
        }
    }
    insert_pairs(conn, &carried, now)?;
    Ok(())
}

/// Folds absorbed track `n` onto kept track `o`. Slots and plays union onto o; edits fill o's empty
/// fields; genres and an assigned cover move only into an o that has none. A filed o keeps its album
/// and n leaves its own; a loose o takes n's place.
fn carry_track(conn: &Connection, o: i64, n: i64, now: i64) -> rusqlite::Result<()> {
    repoint(conn, SLOTS, n, o)?;
    repoint(conn, PLAYS, n, o)?;
    carry_edits(conn, o, n)?;
    for table in ["track_genres", "track_covers"] {
        if !has_row(conn, table, o)? {
            conn.execute(
                &format!("UPDATE {table} SET track_id = ?1 WHERE track_id = ?2"),
                params![o, n],
            )?;
        }
    }
    if let Some(m) = membership_row(conn, n)? {
        let o_loose = membership_album(conn, o)?.is_none();
        remove_membership(conn, n)?;
        if o_loose {
            insert_membership(conn, &MergeMembership { track_id: o, ..m })?;
        }
        set_updated_at(conn, m.album_id, now)?;
    }
    Ok(())
}

fn carry_edits(conn: &Connection, o: i64, n: i64) -> rusqlite::Result<()> {
    if !has_row(conn, "track_edits", n)? {
        return Ok(());
    }
    if !has_row(conn, "track_edits", o)? {
        conn.execute(
            "UPDATE track_edits SET track_id = ?1 WHERE track_id = ?2",
            params![o, n],
        )?;
        return Ok(());
    }
    let fills = EDIT_COLUMNS
        .iter()
        .map(|c| format!("{c} = COALESCE({c}, (SELECT {c} FROM track_edits WHERE track_id = ?2))"))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute(
        &format!("UPDATE track_edits SET {fills} WHERE track_id = ?1"),
        params![o, n],
    )?;
    Ok(())
}

fn has_row(conn: &Connection, table: &str, track_id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE track_id = ?1)"),
        params![track_id],
        |r| r.get(0),
    )
}

fn scan_values(conn: &Connection, track_id: i64) -> rusqlite::Result<Vec<Value>> {
    conn.query_row(
        &format!(
            "SELECT {} FROM tracks WHERE id = ?1",
            SCAN_COLUMNS.join(", ")
        ),
        params![track_id],
        |r| {
            (0..SCAN_COLUMNS.len())
                .map(|i| r.get::<_, Value>(i))
                .collect()
        },
    )
}

fn set_scan_values(conn: &Connection, track_id: i64, values: &[Value]) -> rusqlite::Result<()> {
    let sets = SCAN_COLUMNS
        .iter()
        .enumerate()
        .map(|(i, c)| format!("{c} = ?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "UPDATE tracks SET {sets} WHERE id = ?{}",
        SCAN_COLUMNS.len() + 1
    );
    let args = values.iter().cloned().chain([Value::Integer(track_id)]);
    conn.execute(&sql, params_from_iter(args))?;
    Ok(())
}

// ---- Earlier paths ----

/// Records that `root_id` moved from `old_path` to `new_path`. Its earlier paths stay most recent
/// first, without repeats or the current path, capped at MAX_EARLIER. An `absorbed` root's history
/// joins this one and its own entry goes.
fn record_move(
    conn: &Connection,
    root_id: i64,
    old_path: &str,
    new_path: &str,
    absorbed: Option<i64>,
) -> rusqlite::Result<()> {
    let mut moves = root_moves(conn)?;
    let mut earlier = vec![old_path.to_string()];
    if let Some(prior) = take_move(&mut moves, root_id) {
        earlier.extend(prior.earlier);
    }
    if let Some(prior) = absorbed.and_then(|id| take_move(&mut moves, id)) {
        earlier.extend(prior.earlier);
    }
    let mut seen = HashSet::new();
    earlier.retain(|p| p != new_path && seen.insert(p.clone()));
    earlier.truncate(MAX_EARLIER);
    moves.push(RootMove {
        root_id,
        path: new_path.to_string(),
        earlier,
    });
    write_moves(conn, moves)
}

fn take_move(moves: &mut Vec<RootMove>, root_id: i64) -> Option<RootMove> {
    let at = moves.iter().position(|m| m.root_id == root_id)?;
    Some(moves.remove(at))
}

fn write_moves(conn: &Connection, mut moves: Vec<RootMove>) -> rusqlite::Result<()> {
    moves.sort_by_key(|m| m.root_id);
    let json = serde_json::to_string(&moves)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    set_setting(conn, ROOT_MOVES, &json)
}

fn io_failure(e: std::io::Error) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_IOERR),
        Some(e.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::normalize::folder_of;

    const OLD: &str = "/Music/Old";
    const NEW: &str = "/Volumes/Disk/Music";

    // The real-case path a walk of `root` yields for the file at `parts` below it.
    fn walk(root: &str, parts: &[&str]) -> String {
        parts
            .iter()
            .fold(PathBuf::from(root), |p, c| p.join(c))
            .to_string_lossy()
            .into_owned()
    }

    fn add_root(conn: &Connection, path: &str) -> i64 {
        db::insert_root(conn, &normalize_path_key(path), path, 1).unwrap()
    }

    // Inserts a track keyed the way a scan of `root` keys it.
    fn add_track(conn: &Connection, root_id: i64, root: &str, parts: &[&str], size: i64) -> i64 {
        let display = walk(root, parts);
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 has_embedded_cover, scanned_at, root_id)
             VALUES (?1, ?2, ?3, 'mp3', ?4, 20, 0, 30, ?5)",
            params![
                normalize_path_key(&display),
                display,
                parts[parts.len() - 1],
                size,
                root_id
            ],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn add_cover(conn: &Connection, hash: &str) -> i64 {
        conn.execute(
            "INSERT INTO covers (content_hash, source_kind, width, height, byte_len, created_at)
             VALUES (?1, 'imported', 1, 1, 1, 1)",
            params![hash],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // Binds a cover to the folder holding `track_id`, keyed as the app keys it.
    fn cover_folder_of(conn: &Connection, track_id: i64, cover_id: i64) -> String {
        let folder = folder_of(&paths_of(conn, track_id).0);
        db::set_folder_cover(conn, &folder, cover_id, 1).unwrap();
        folder
    }

    fn paths_of(conn: &Connection, track_id: i64) -> (String, Option<String>) {
        conn.query_row(
            "SELECT source_path, display_path FROM tracks WHERE id = ?1",
            params![track_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    // The folder key a walk of `root` gives the file at `parts`.
    fn walked_folder(root: &str, parts: &[&str]) -> String {
        folder_of(&normalize_path_key(&walk(root, parts)))
    }

    fn root_of(conn: &Connection, root_id: i64) -> Option<(String, String)> {
        conn.query_row(
            "SELECT path, root_key FROM roots WHERE id = ?1",
            params![root_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap()
    }

    fn folder_cover(conn: &Connection, folder: &str) -> Option<i64> {
        db::get_folder_cover(conn, folder).unwrap()
    }

    fn ids(conn: &Connection, sql: &str, id: i64) -> Vec<i64> {
        conn.prepare(sql)
            .unwrap()
            .query_map(params![id], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn one(conn: &Connection, sql: &str, id: i64) -> i64 {
        conn.query_row(sql, params![id], |r| r.get(0)).unwrap()
    }

    // Every row of `table` in a stable order, every column as a raw value.
    fn dump(conn: &Connection, table: &str, order: &str) -> Vec<Vec<Value>> {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY {order}"))
            .unwrap();
        let cols = stmt.column_count();
        stmt.query_map([], |r| (0..cols).map(|i| r.get::<_, Value>(i)).collect())
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    // Every table a relocate may write, dumped together for before/after comparison.
    fn whole_state(conn: &Connection) -> Vec<Vec<Vec<Value>>> {
        vec![
            dump(conn, "roots", "id"),
            dump(conn, "tracks", "id"),
            dump(conn, "folder_covers", "folder_path"),
            dump(conn, "settings", "key"),
            dump(conn, "albums", "id"),
            dump(conn, "album_tracks", "track_id"),
            dump(conn, "playlist_tracks", "id"),
            dump(conn, "plays", "id"),
            dump(conn, "track_edits", "track_id"),
            dump(conn, "track_genres", "track_id, genre_id"),
            dump(conn, "track_covers", "track_id"),
            dump(conn, "duplicate_dismissals", "track_lo, track_hi"),
        ]
    }

    fn entry(conn: &Connection, root_id: i64) -> Option<RootMove> {
        root_moves(conn)
            .unwrap()
            .into_iter()
            .find(|m| m.root_id == root_id)
    }

    // ---- Move ----

    #[test]
    fn move_keeps_ids_and_rewrites_paths_root_and_folder_covers() {
        let mut conn = db::open_in_memory().unwrap();
        let root = add_root(&conn, OLD);
        let other = add_root(&conn, "/Other");
        let files: [&[&str]; 3] = [
            &["Top.mp3"],
            &["Album", "1.mp3"],
            &["Album", "Disc 2", "2.mp3"],
        ];
        let tracks: Vec<i64> = files
            .iter()
            .map(|parts| add_track(&conn, root, OLD, parts, 10))
            .collect();
        let stay = add_track(&conn, other, "/Other", &["x.mp3"], 10);
        let cover = add_cover(&conn, "c");
        let top_folder = cover_folder_of(&conn, tracks[0], cover);
        let album_folder = cover_folder_of(&conn, tracks[1], cover);
        let other_folder = cover_folder_of(&conn, stay, cover);
        let stay_before = paths_of(&conn, stay);

        let report = move_root(&mut conn, root, NEW).unwrap();

        assert_eq!(report.moved, 3);
        for (id, parts) in tracks.iter().zip(files) {
            let walked = walk(NEW, parts);
            assert_eq!(
                paths_of(&conn, *id),
                (normalize_path_key(&walked), Some(walked))
            );
        }
        assert_eq!(
            paths_of(&conn, stay),
            stay_before,
            "another root is untouched"
        );
        assert_eq!(
            root_of(&conn, root),
            Some((NEW.to_string(), normalize_path_key(NEW)))
        );

        assert_eq!(folder_cover(&conn, &top_folder), None);
        assert_eq!(folder_cover(&conn, &album_folder), None);
        assert_eq!(
            folder_cover(&conn, &walked_folder(NEW, files[0])),
            Some(cover),
            "a cover on the root folder itself follows it"
        );
        assert_eq!(
            folder_cover(&conn, &walked_folder(NEW, files[1])),
            Some(cover)
        );
        assert_eq!(folder_cover(&conn, &other_folder), Some(cover));
        assert_eq!(entry(&conn, root).unwrap().earlier, vec![OLD]);
    }

    #[cfg(windows)]
    #[test]
    fn a_case_only_move_changes_display_values_only() {
        let mut conn = db::open_in_memory().unwrap();
        let root = add_root(&conn, OLD);
        let id = add_track(&conn, root, OLD, &["Album", "1.mp3"], 10);
        let (key_before, _) = paths_of(&conn, id);
        let recased = "/MUSIC/old";

        move_root(&mut conn, root, recased).unwrap();

        assert_eq!(
            paths_of(&conn, id),
            (key_before, Some(walk(recased, &["Album", "1.mp3"])))
        );
        assert_eq!(
            root_of(&conn, root),
            Some((recased.to_string(), normalize_path_key(OLD)))
        );
    }

    #[test]
    fn an_out_of_prefix_row_aborts_with_every_table_unchanged() {
        let mut conn = db::open_in_memory().unwrap();
        let root = add_root(&conn, OLD);
        let other = add_root(&conn, NEW);
        let inside = add_track(&conn, root, OLD, &["Album", "1.mp3"], 10);
        let stray = add_track(&conn, root, "/Elsewhere", &["2.mp3"], 10);
        add_track(&conn, other, NEW, &["Album", "1.mp3"], 10);
        cover_folder_of(&conn, inside, add_cover(&conn, "c"));
        let before = whole_state(&conn);

        assert!(matches!(
            move_root(&mut conn, root, "/Music/New"),
            Err(RelocateError::OutOfPrefix { track_id }) if track_id == stray
        ));
        assert_eq!(whole_state(&conn), before);

        assert!(matches!(
            merge_root(&mut conn, root, other, 50),
            Err(RelocateError::OutOfPrefix { track_id }) if track_id == stray
        ));
        assert_eq!(whole_state(&conn), before);
    }

    #[test]
    fn a_gone_root_or_a_merge_into_itself_is_refused() {
        let mut conn = db::open_in_memory().unwrap();
        let root = add_root(&conn, OLD);
        assert!(matches!(
            move_root(&mut conn, 999, NEW),
            Err(RelocateError::RootGone)
        ));
        assert!(matches!(
            merge_root(&mut conn, root, 999, 50),
            Err(RelocateError::RootGone)
        ));
        assert!(matches!(
            merge_root(&mut conn, root, root, 50),
            Err(RelocateError::SameRoot)
        ));
    }

    // ---- Merge ----

    // Three pairs, one track only under the absorbed root and one only under the kept root.
    struct Fx {
        keep: i64,
        absorb: i64,
        o: [i64; 3],
        n: [i64; 3],
        keep_only: i64,
        absorb_only: i64,
        old_album: i64,
        new_album: i64,
        since_album: i64,
        playlist: i64,
        genres: [i64; 2],
        covers: [i64; 4],
    }

    fn album(conn: &mut Connection, title: &str, members: &[i64]) -> i64 {
        db::create_album(
            conn,
            Some(title.into()),
            None,
            None,
            None,
            None,
            members,
            db::ALBUM_KIND,
            5,
        )
        .unwrap()
        .id
    }

    fn merge_fixture(conn: &mut Connection) -> Fx {
        let keep = add_root(conn, OLD);
        let absorb = add_root(conn, NEW);
        let o = [
            add_track(conn, keep, OLD, &["A", "1.mp3"], 11),
            add_track(conn, keep, OLD, &["A", "2.mp3"], 12),
            add_track(conn, keep, OLD, &["B", "3.mp3"], 13),
        ];
        let keep_only = add_track(conn, keep, OLD, &["C", "old.mp3"], 14);
        let n = [
            add_track(conn, absorb, NEW, &["A", "1.mp3"], 21),
            add_track(conn, absorb, NEW, &["A", "2.mp3"], 22),
            add_track(conn, absorb, NEW, &["B", "3.mp3"], 23),
        ];
        let absorb_only = add_track(conn, absorb, NEW, &["D", "new.mp3"], 24);
        // The kept root went offline, so its files read as gone.
        conn.execute(
            "UPDATE tracks SET missing_at = 40 WHERE root_id = ?1",
            params![keep],
        )
        .unwrap();

        // o[0] is loose, o[1] and o[2] are filed, and n[1] and n[2] fill an album made since.
        let old_album = album(conn, "Old", &[o[1], o[2], keep_only]);
        let new_album = album(conn, "New", &[n[0], absorb_only]);
        let since_album = album(conn, "Since", &[n[1], n[2]]);

        conn.execute(
            "INSERT INTO playlists (created_at, updated_at) VALUES (1, 1)",
            [],
        )
        .unwrap();
        let playlist = conn.last_insert_rowid();
        for (pos, track) in [o[0], n[0], absorb_only].iter().enumerate() {
            conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
                params![playlist, track, pos as i64 + 1],
            )
            .unwrap();
        }
        for (track, plays) in [(o[0], 2), (n[0], 3), (absorb_only, 1)] {
            for i in 0..plays {
                conn.execute(
                    "INSERT INTO plays (track_id, played_at, completed) VALUES (?1, ?2, 1)",
                    params![track, 100 + i],
                )
                .unwrap();
            }
        }

        conn.execute(
            "INSERT INTO track_edits (track_id, title, updated_at) VALUES (?1, 'Kept title', 1)",
            params![o[0]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO track_edits (track_id, title, artist, updated_at)
             VALUES (?1, 'New title', 'New artist', 2)",
            params![n[0]],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO track_edits (track_id, year, updated_at) VALUES (?1, 1999, 3)",
            params![n[1]],
        )
        .unwrap();

        let genres = [
            db::create_genre(conn, "Rock", 1).unwrap().id,
            db::create_genre(conn, "Jazz", 1).unwrap().id,
        ];
        db::set_track_genres(conn, o[0], &[genres[0]]).unwrap();
        db::set_track_genres(conn, n[0], &[genres[1]]).unwrap();
        db::set_track_genres(conn, n[1], &[genres[1]]).unwrap();

        let covers = [
            add_cover(conn, "c0"),
            add_cover(conn, "c1"),
            add_cover(conn, "c2"),
            add_cover(conn, "c3"),
        ];
        db::set_track_cover(conn, &[o[0]], covers[0], 1).unwrap();
        db::set_track_cover(conn, &[n[0], n[2]], covers[1], 1).unwrap();
        // Folder A has a cover under both roots, C only under the kept one, D only under the
        // absorbed one.
        cover_folder_of(conn, o[0], covers[0]);
        cover_folder_of(conn, keep_only, covers[2]);
        cover_folder_of(conn, n[0], covers[1]);
        cover_folder_of(conn, absorb_only, covers[3]);

        db::dismiss_duplicates(conn, &[o[0], n[0]], 7).unwrap();
        db::dismiss_duplicates(conn, &[n[1], keep_only], 7).unwrap();
        db::dismiss_duplicates(conn, &[n[2], absorb_only], 7).unwrap();

        Fx {
            keep,
            absorb,
            o,
            n,
            keep_only,
            absorb_only,
            old_album,
            new_album,
            since_album,
            playlist,
            genres,
            covers,
        }
    }

    #[test]
    fn plan_merge_pairs_by_relative_path() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);

        let plan = plan_merge(&conn, fx.keep, fx.absorb).unwrap();

        assert_eq!(
            plan.pairs,
            vec![(fx.o[0], fx.n[0]), (fx.o[1], fx.n[1]), (fx.o[2], fx.n[2])]
        );
        assert_eq!(plan.absorb_only, vec![fx.absorb_only]);
        assert_eq!(plan.keep_only, vec![fx.keep_only]);
    }

    #[test]
    fn merge_unions_plays_and_slots_onto_the_kept_track() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        assert_eq!(
            one(
                &conn,
                "SELECT COUNT(*) FROM plays WHERE track_id = ?1",
                fx.o[0]
            ),
            5
        );
        assert_eq!(
            ids(
                &conn,
                "SELECT track_id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position",
                fx.playlist
            ),
            vec![fx.o[0], fx.o[0], fx.absorb_only],
            "the playlist holds the kept track twice"
        );
    }

    #[test]
    fn merge_fills_edit_gaps_and_moves_genres_and_covers_only_into_an_empty_track() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        let edit = |id: i64| -> (Option<String>, Option<String>, Option<i64>) {
            conn.query_row(
                "SELECT title, artist, year FROM track_edits WHERE track_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };
        assert_eq!(
            edit(fx.o[0]),
            (Some("Kept title".into()), Some("New artist".into()), None)
        );
        assert_eq!(
            edit(fx.o[1]),
            (None, None, Some(1999)),
            "an unedited track takes the whole row"
        );

        let genres_of = |id| {
            ids(
                &conn,
                "SELECT genre_id FROM track_genres WHERE track_id = ?1",
                id,
            )
        };
        assert_eq!(genres_of(fx.o[0]), vec![fx.genres[0]]);
        assert_eq!(genres_of(fx.o[1]), vec![fx.genres[1]]);

        assert_eq!(
            db::get_track_cover_id(&conn, fx.o[0]).unwrap(),
            Some(fx.covers[0])
        );
        assert_eq!(
            db::get_track_cover_id(&conn, fx.o[2]).unwrap(),
            Some(fx.covers[1])
        );
    }

    #[test]
    fn merge_settles_membership_with_the_kept_track_winning() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        let album_of = |id| db::membership_album(&conn, id).unwrap();
        assert_eq!(
            album_of(fx.o[0]),
            Some(fx.new_album),
            "a loose track takes its twin's place"
        );
        assert_eq!(
            album_of(fx.o[1]),
            Some(fx.old_album),
            "a filed track keeps its album"
        );
        assert_eq!(album_of(fx.o[2]), Some(fx.old_album));
        assert!(db::get_album(&conn, fx.since_album).unwrap().is_none());
        assert_eq!(
            db::get_album(&conn, fx.new_album)
                .unwrap()
                .unwrap()
                .updated_at,
            50
        );
        assert_eq!(
            db::get_album(&conn, fx.old_album)
                .unwrap()
                .unwrap()
                .updated_at,
            5
        );
    }

    #[test]
    fn merge_empties_the_albums_plan_merge_predicts() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);
        let plan = plan_merge(&conn, fx.keep, fx.absorb).unwrap();

        let report = merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        assert_eq!(plan.albums_emptied, 1);
        assert_eq!(report.albums_emptied, plan.albums_emptied);
        assert_eq!((report.moved, report.merged, report.carried), (1, 3, 1));
    }

    #[test]
    fn merge_carries_dismissals_and_drops_the_twin_pair() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        let pair = |a: i64, b: i64| DismissedPair {
            track_lo: a.min(b),
            track_hi: a.max(b),
        };
        assert_eq!(
            db::list_duplicate_dismissals(&conn).unwrap(),
            vec![pair(fx.o[1], fx.keep_only), pair(fx.o[2], fx.absorb_only)]
        );
    }

    #[test]
    fn merge_restamps_absorbed_only_rows_and_hands_over_the_root_key() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);
        let absorbed_paths = paths_of(&conn, fx.absorb_only);

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        assert_eq!(paths_of(&conn, fx.absorb_only), absorbed_paths);
        assert_eq!(
            one(
                &conn,
                "SELECT root_id FROM tracks WHERE id = ?1",
                fx.absorb_only
            ),
            fx.keep
        );
        assert_eq!(root_of(&conn, fx.absorb), None);
        assert_eq!(
            root_of(&conn, fx.keep),
            Some((NEW.to_string(), normalize_path_key(NEW)))
        );
        for n in fx.n {
            assert_eq!(
                one(&conn, "SELECT COUNT(*) FROM tracks WHERE id = ?1", n),
                0
            );
        }
        let walked = walk(NEW, &["C", "old.mp3"]);
        assert_eq!(
            paths_of(&conn, fx.keep_only),
            (normalize_path_key(&walked), Some(walked)),
            "a kept-only track is rewritten under the new path"
        );
    }

    #[test]
    fn merge_gives_a_paired_track_the_absorbed_scan_columns() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);
        conn.execute(
            "UPDATE tracks SET raw_title = 'Fresh', mtime = 77, duration_secs = 3.5 WHERE id = ?1",
            params![fx.n[0]],
        )
        .unwrap();
        let fresh = scan_values(&conn, fx.n[0]).unwrap();

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        assert_eq!(scan_values(&conn, fx.o[0]).unwrap(), fresh);
        assert_eq!(
            one(
                &conn,
                "SELECT missing_at IS NULL FROM tracks WHERE id = ?1",
                fx.o[0]
            ),
            1,
            "the fresh read is present, so the kept track no longer reads as gone"
        );
    }

    #[test]
    fn merge_folder_covers_keep_the_kept_choice_on_collision() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        assert_eq!(
            folder_cover(&conn, &walked_folder(NEW, &["A", "1.mp3"])),
            Some(fx.covers[0])
        );
        assert_eq!(
            folder_cover(&conn, &walked_folder(NEW, &["C", "old.mp3"])),
            Some(fx.covers[2])
        );
        assert_eq!(
            folder_cover(&conn, &walked_folder(NEW, &["D", "new.mp3"])),
            Some(fx.covers[3]),
            "an absorbed-only cover stays"
        );
        assert_eq!(dump(&conn, "folder_covers", "folder_path").len(), 3);
    }

    // ---- Earlier paths ----

    #[test]
    fn root_moves_record_cap_and_chain() {
        let mut conn = db::open_in_memory().unwrap();
        let root = add_root(&conn, "/A");
        add_track(&conn, root, "/A", &["1.mp3"], 10);

        move_root(&mut conn, root, "/B").unwrap();
        move_root(&mut conn, root, "/C").unwrap();
        assert_eq!(
            entry(&conn, root),
            Some(RootMove {
                root_id: root,
                path: "/C".into(),
                earlier: vec!["/B".into(), "/A".into()],
            })
        );

        for path in ["/D", "/E", "/F", "/G"] {
            move_root(&mut conn, root, path).unwrap();
        }
        assert_eq!(
            entry(&conn, root).unwrap().earlier,
            vec!["/F", "/E", "/D", "/C"],
            "capped, most recent first"
        );

        move_root(&mut conn, root, "/E").unwrap();
        assert_eq!(
            entry(&conn, root).unwrap().earlier,
            vec!["/G", "/F", "/D", "/C"],
            "the current path is never also an earlier one"
        );
    }

    #[test]
    fn merge_unions_the_absorbed_history() {
        let mut conn = db::open_in_memory().unwrap();
        let fx = merge_fixture(&mut conn);
        let prior = [
            RootMove {
                root_id: fx.keep,
                path: OLD.into(),
                earlier: vec!["/Music/Older".into()],
            },
            RootMove {
                root_id: fx.absorb,
                path: NEW.into(),
                earlier: vec!["/Music/Ancient".into()],
            },
        ];
        set_setting(&conn, ROOT_MOVES, &serde_json::to_string(&prior).unwrap()).unwrap();

        merge_root(&mut conn, fx.keep, fx.absorb, 50).unwrap();

        assert_eq!(
            root_moves(&conn).unwrap(),
            vec![RootMove {
                root_id: fx.keep,
                path: NEW.into(),
                earlier: vec![OLD.into(), "/Music/Older".into(), "/Music/Ancient".into()],
            }]
        );
    }

    #[test]
    fn remove_root_drops_its_root_moves_entry() {
        let mut conn = db::open_in_memory().unwrap();
        let a = add_root(&conn, "/A");
        let b = add_root(&conn, "/B");
        move_root(&mut conn, a, "/A2").unwrap();
        move_root(&mut conn, b, "/B2").unwrap();

        db::remove_root(&mut conn, a).unwrap();

        assert_eq!(entry(&conn, a), None);
        assert!(entry(&conn, b).is_some(), "another root keeps its entry");
    }

    #[test]
    fn an_absent_or_garbled_root_moves_value_reads_as_none() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(root_moves(&conn).unwrap(), vec![]);
        set_setting(&conn, ROOT_MOVES, "{not json").unwrap();
        assert_eq!(root_moves(&conn).unwrap(), vec![]);
    }

    // ---- Backup ----

    #[test]
    fn backup_to_writes_a_readable_copy_and_replaces_the_previous_one() {
        let dir = std::env::temp_dir().join(format!(
            "plisto_relocate_backup_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("plisto.relocate-backup.sqlite");
        let conn = db::open_in_memory().unwrap();
        let roots_in = |path: &Path| -> Vec<String> {
            let copy = Connection::open(path).unwrap();
            let mut stmt = copy.prepare("SELECT path FROM roots ORDER BY id").unwrap();
            let rows = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            rows
        };

        add_root(&conn, "/A");
        backup_to(&conn, &dest).unwrap();
        assert_eq!(roots_in(&dest), vec!["/A"]);

        add_root(&conn, "/B");
        backup_to(&conn, &dest).unwrap();
        assert_eq!(roots_in(&dest), vec!["/A", "/B"]);
        assert!(
            !dest.with_extension("tmp").exists(),
            "no temp file is left behind"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
