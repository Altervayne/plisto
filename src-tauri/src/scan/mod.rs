/*
 * The scan pipeline: walk the workspace once for its exact file count, read tags in parallel
 * with rayon, feed a bounded channel, and let a single writer thread own the write connection
 * and commit batched upserts. A dedicated thread samples an atomic counter and emits throttled
 * progress with a guaranteed terminal tick. Cancellation is an atomic flag checked between walk
 * entries and at the top of each worker, so a cancelled scan leaves a valid partial index and
 * never reconciles. A vanished file is flagged missing, never deleted, only after a complete
 * pass, and a returned file's flag is cleared there too. An unreachable root or an unreadable
 * folder is never taken as empty: its rows are left as they are. A root can be narrowed to a set of
 * units (folders, recursive or not); the walk and the reconcile then stay inside them.
 */

// -- Module Declarations --
mod deferral;
pub mod progress;
mod tags;

// -- Library Imports --
use std::collections::HashMap;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver};
use rayon::prelude::*;
use rusqlite::{params, Connection};
use walkdir::WalkDir;

// -- Local Imports --
use crate::db;
use crate::dto::{ScanPhase, ScanProgress, ScanSummary};
use crate::model::TrackRecord;
use crate::normalize::{folder_of, is_audio, needs_reread, normalize_path_key, normalize_track};
use deferral::{read_decision, share_locked, ReadDecision};
use progress::ProgressThrottle;
// Re-exported so ad-hoc playback reads a lone file's tags through the same reader the scan uses.
pub(crate) use tags::read_tags;

// Rows committed per transaction. A batch keeps each transaction short so a reader is never
// blocked for long, without paying a commit per file.
const WRITE_BATCH: u32 = 512;

// Bound on the channel between workers and the writer, so fast readers cannot outrun the DB
// and balloon memory on a large library.
const CHANNEL_CAP: usize = 1024;

// How often the progress thread wakes to sample the counter. Faster than the emit interval so
// a finished scan is noticed quickly; the throttle coalesces the wakeups into steady ticks.
const PROGRESS_POLL: Duration = Duration::from_millis(50);
const PROGRESS_INTERVAL_MS: u64 = 100;

/// One folder of a narrowed pass. A recursive unit covers its whole subtree; a non-recursive one only
/// the files directly inside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanUnit {
    pub dir: PathBuf,
    pub recursive: bool,
}

/// One root to walk this pass: its id and its real-case anchor path. The writer stamps every track
/// it upserts with this id, and reconcile scopes to the set of ids walked. `units` narrows the walk
/// and the reconcile to those folders; None walks the whole root.
pub struct ScanRoot {
    pub id: i64,
    pub path: PathBuf,
    pub units: Option<Vec<ScanUnit>>,
}

/// What a scan reports while it runs: throttled progress ticks, and the ids of rows it just
/// committed (upserted, or flagged or cleared by reconcile), one batch per commit.
pub enum ScanEmit {
    Progress(ScanProgress),
    Changed(Vec<i64>),
}

/// Runs a scan over `roots`, writing into the database at `db_path`. Each root is walked in turn,
/// `seen` is the union of every walk, and each upserted track is stamped with its own root's id.
/// `cancel` stops the walk and the workers; `scanned_at` stamps every row written this pass and is
/// the deferral clock; `deferred_since` maps a canonical key to when that file was first deferred;
/// `emit` receives throttled progress ticks and the changed-id batches. Returns the counts once the
/// writer has drained and (on a complete pass) reconciled presence, scoped to what was walked:
/// vanished files there flagged missing, returned ones cleared. Scanning one root never touches
/// another root's rows. A root that cannot be read, before the walk, during it, or just before
/// reconcile, is never taken as empty: it leaves the reconcile scope and its id is reported in
/// `offline_roots`.
pub fn run_scan<E>(
    roots: &[ScanRoot],
    db_path: &Path,
    cancel: &Arc<AtomicBool>,
    scanned_at: i64,
    deferred_since: &HashMap<String, i64>,
    emit: E,
) -> Result<ScanSummary, String>
where
    E: Fn(ScanEmit) + Sync,
{
    emit(ScanEmit::Progress(ScanProgress {
        phase: ScanPhase::Enumerating,
        scanned: 0,
        total: 0,
        errors: 0,
        done: false,
    }));

    // The writer's own connection: open_db applies the pragmas and ensures the schema, so a
    // fresh db_path is created here and an existing one is a no-op migration.
    let conn = db::open_db(db_path).map_err(|e| e.to_string())?;

    let stats_map = load_stats(&conn).map_err(|e| e.to_string())?;

    // Walk each root once, tagging every path with its root id. `seen` (folded key -> real-case
    // path) is the union the sweep needs, both to reconcile presence and to drain display_path;
    // `scopes` is the reconcile scope and `failed_dirs` the folders inside it left unflagged.
    let mut work: Vec<(PathBuf, i64)> = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut failed_dirs: Vec<String> = Vec::new();
    let mut scopes: Vec<Scope> = Vec::new();
    let mut offline_roots: Vec<i64> = Vec::new();
    for root in roots {
        // An unplugged drive or a deleted folder would walk as empty and flag every track missing.
        if !root_reachable(&root.path) {
            offline_roots.push(root.id);
            continue;
        }
        let walk = enumerate(root, cancel);
        if walk.offline {
            offline_roots.push(root.id);
            continue;
        }
        work.extend(walk.paths.into_iter().map(|p| (p, root.id)));
        seen.extend(walk.seen);
        failed_dirs.extend(walk.failed_dirs);
        scopes.push(Scope::of(root));
    }
    let total = work.len() as u32;

    let scanned = AtomicUsize::new(0);
    let inserted = AtomicUsize::new(0);
    let updated = AtomicUsize::new(0);
    let skipped = AtomicUsize::new(0);
    let errors = AtomicUsize::new(0);
    let deferred: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let done = AtomicBool::new(false);

    let (tx, rx) = bounded::<(TrackRecord, i64)>(CHANNEL_CAP);

    let (missing, returned, gone) = std::thread::scope(|s| -> Result<WriterOutcome, String> {
        // The progress emitter: samples the counters and emits throttled ticks until the walk
        // finishes, then fires the single terminal tick.
        let progress_handle = s.spawn(|| {
            let start = Instant::now();
            let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL_MS);
            loop {
                let is_done = done.load(Ordering::Relaxed);
                let now_ms = start.elapsed().as_millis() as u64;
                if throttle.should_emit(now_ms, is_done) {
                    emit(ScanEmit::Progress(ScanProgress {
                        phase: if is_done {
                            ScanPhase::Done
                        } else {
                            ScanPhase::Reading
                        },
                        scanned: scanned.load(Ordering::Relaxed) as u32,
                        total,
                        errors: errors.load(Ordering::Relaxed) as u32,
                        done: is_done,
                    }));
                }
                if is_done {
                    break;
                }
                std::thread::sleep(PROGRESS_POLL);
            }
        });

        // The single writer, owning the write connection.
        let writer_cancel = Arc::clone(cancel);
        let emit_ref = &emit;
        let reconcile = ReconcileInput {
            seen,
            failed_dirs: &failed_dirs,
            scopes: &scopes,
        };
        let writer_handle =
            s.spawn(move || writer_loop(conn, rx, reconcile, scanned_at, writer_cancel, emit_ref));

        // Fan out the reads. Each worker classifies against the pre-scan stats, so the writer
        // stays a pure sink, and carries its path's root id so the writer stamps it.
        work.par_iter().for_each(|(path, root_id)| {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let path_str = path.to_string_lossy();
            let key = normalize_path_key(&path_str);
            let Some(stat) = file_stats(path) else {
                return;
            };

            let known = stats_map.get(&key);
            if let Some((ssize, smtime, art_known)) = known {
                if !needs_reread((*ssize, *smtime), stat, *art_known) {
                    scanned.fetch_add(1, Ordering::Relaxed);
                    skipped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }

            // A file still being copied is held open by the writer or moves under the read: defer it
            // rather than index a torn read. It is present, so it is neither an error nor missing.
            let locked = share_locked(path);
            let read = (!locked).then(|| (read_tags(path), file_stats(path)));
            let after = read.as_ref().and_then(|(_, after)| *after);
            let since = deferred_since.get(&key).copied();
            if read_decision(locked, stat, after, since, scanned_at) == ReadDecision::Defer {
                if let Ok(mut list) = deferred.lock() {
                    list.push(path.clone());
                }
                scanned.fetch_add(1, Ordering::Relaxed);
                return;
            }
            let (raw, is_err) = match read {
                Some((tags, _)) => tags,
                None => read_tags(path),
            };

            if known.is_some() {
                updated.fetch_add(1, Ordering::Relaxed);
            } else {
                inserted.fetch_add(1, Ordering::Relaxed);
            }
            if is_err {
                errors.fetch_add(1, Ordering::Relaxed);
            }
            let rec = normalize_track(&path_str, stat.0, stat.1, scanned_at, &raw);
            let _ = tx.send((rec, *root_id));
            scanned.fetch_add(1, Ordering::Relaxed);
        });

        // Closing the channel lets the writer finish its drain.
        drop(tx);
        let counts = writer_handle
            .join()
            .map_err(|_| "scan writer thread panicked".to_string())??;

        done.store(true, Ordering::Relaxed);
        progress_handle
            .join()
            .map_err(|_| "scan progress thread panicked".to_string())?;

        Ok(counts)
    })?;
    offline_roots.extend(gone);
    let deferred_paths = deferred.into_inner().unwrap_or_default();

    Ok(ScanSummary {
        total,
        seen: scanned.load(Ordering::Relaxed) as u32,
        inserted: inserted.load(Ordering::Relaxed) as u32,
        updated: updated.load(Ordering::Relaxed) as u32,
        skipped: skipped.load(Ordering::Relaxed) as u32,
        // Reserved for a future confirmation-gated purge; a scan never deletes.
        removed: 0,
        missing,
        returned,
        errors: errors.load(Ordering::Relaxed) as u32,
        cancelled: cancel.load(Ordering::Relaxed),
        offline_roots,
        deferred: deferred_paths.len() as u32,
        deferred_paths,
    })
}

/// Whether a root's folder can be listed right now. A failure means offline, not empty.
pub(crate) fn root_reachable(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok()
}

/// The canonical key of a folder: trailing separators dropped (a drive root keeps its own), then
/// folded like a track's source path, so it compares against `folder_of` and key prefixes.
pub(crate) fn dir_key(dir: &Path) -> String {
    normalize_path_key(&dir.components().collect::<PathBuf>().to_string_lossy())
}

/// A unit as the reconcile sees it: its folder's canonical key and whether it covers the subtree.
#[derive(Debug, Clone)]
pub(crate) struct UnitKey {
    pub key: String,
    pub recursive: bool,
}

impl UnitKey {
    pub(crate) fn of(unit: &ScanUnit) -> Self {
        Self {
            key: dir_key(&unit.dir),
            recursive: unit.recursive,
        }
    }

    /// Whether the canonical track `key` lies inside this unit.
    pub(crate) fn covers(&self, key: &str) -> bool {
        if self.recursive {
            under_dir(key, &self.key)
        } else {
            folder_of(key) == self.key
        }
    }
}

/// One walked root's reconcile scope: its id and anchor, and its units when the pass was narrowed.
struct Scope {
    id: i64,
    path: PathBuf,
    units: Option<Vec<UnitKey>>,
}

impl Scope {
    fn of(root: &ScanRoot) -> Self {
        Self {
            id: root.id,
            path: root.path.clone(),
            units: root
                .units
                .as_ref()
                .map(|units| units.iter().map(UnitKey::of).collect()),
        }
    }
}

/// Loads each indexed track's (size, mtime, art_known) into a map keyed by the canonical path,
/// so the incremental check never queries the DB per file. `art_known` is whether the row's
/// `has_embedded_cover` is non-NULL, which the re-read rule uses to drain unexamined rows.
fn load_stats(conn: &Connection) -> rusqlite::Result<HashMap<String, (i64, i64, bool)>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, size_bytes, mtime, has_embedded_cover IS NOT NULL FROM tracks",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?)))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (path, stat) = row?;
        map.insert(path, stat);
    }
    Ok(map)
}

/// One root's walk: the audio paths to read, the seen map for the sweep, and the canonical keys of
/// the folders the walk could not read. `offline` is set when the root itself could not be read.
struct Walk {
    paths: Vec<PathBuf>,
    seen: HashMap<String, String>,
    failed_dirs: Vec<String>,
    offline: bool,
}

/// Walks `root` once, or only its units when it has them, keeping only audio files. Returns the
/// paths to read and a map from each file's canonical key to its real-case path, for the sweep.
/// Cancellation stops the walk, which leaves the seen map partial and is why the sweep is skipped
/// on cancel.
fn enumerate(root: &ScanRoot, cancel: &Arc<AtomicBool>) -> Walk {
    let mut walk = Walk {
        paths: Vec::new(),
        seen: HashMap::new(),
        failed_dirs: Vec::new(),
        offline: false,
    };
    match &root.units {
        None => walk_dir(&mut walk, &root.path, true, true, cancel),
        Some(units) => {
            for unit in units {
                walk_dir(&mut walk, &unit.dir, unit.recursive, false, cancel);
            }
        }
    }
    walk
}

/// Walks one folder into `walk`. A walk error is never taken as an empty folder: a failed subfolder
/// is recorded in `failed_dirs` so reconcile leaves its subtree alone. A failure on the folder itself
/// marks the whole root offline when it is the root; for a unit it is a failed folder, unless the
/// folder no longer exists at all, which inside a reachable root means it was deleted or moved away.
fn walk_dir(walk: &mut Walk, dir: &Path, recursive: bool, is_root: bool, cancel: &AtomicBool) {
    let walker = if recursive {
        WalkDir::new(dir)
    } else {
        WalkDir::new(dir).max_depth(1)
    };
    for entry in walker {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => match err.path() {
                Some(path) if err.depth() > 0 => {
                    walk.failed_dirs
                        .push(normalize_path_key(&path.to_string_lossy()));
                    continue;
                }
                _ if is_root => {
                    walk.offline = true;
                    break;
                }
                _ => {
                    let gone = err
                        .io_error()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound);
                    if !gone {
                        walk.failed_dirs.push(dir_key(dir));
                    }
                    break;
                }
            },
        };
        if !entry.file_type().is_file() {
            continue;
        }
        // Skip Plisto's own staging files: an export writes `.plisto-tmp-<name>` beside the finals, and a
        // failed retag can leave one behind. It carries a real audio extension, so without this the scan
        // would index the temp as a track.
        if entry.file_name().to_string_lossy().starts_with(".plisto-tmp-") {
            continue;
        }
        let is_aud = entry
            .path()
            .extension()
            .map(|e| is_audio(&e.to_string_lossy()))
            .unwrap_or(false);
        if !is_aud {
            continue;
        }
        let path = entry.into_path();
        let real = path.to_string_lossy().into_owned();
        // Units never overlap once collapsed, but a repeat must still be read only once.
        if walk.seen.insert(normalize_path_key(&real), real).is_none() {
            walk.paths.push(path);
        }
    }
}

/// Reads a file's size and mtime. Returns None when the file cannot be stat'd, in which case
/// the worker leaves it out of this pass rather than indexing a row it cannot describe.
fn file_stats(path: &Path) -> Option<(i64, i64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Some((md.len() as i64, mtime))
}

/// The writer's `(missing, returned, gone)`, `gone` being the ids of walked roots found unreachable
/// at reconcile.
type WriterOutcome = (u32, u32, Vec<i64>);

/// What the writer reconciles against once the upserts drain: the walk's seen map, the folders it
/// could not read, and the scope of each walked root.
struct ReconcileInput<'a> {
    seen: HashMap<String, String>,
    failed_dirs: &'a [String],
    scopes: &'a [Scope],
}

/// Drains the channel, committing batched upserts stamped with each track's root id, then
/// reconciles presence on a complete pass. Owns its connection for the whole scan. The ids of the
/// rows each commit touched go out through `emit` once that commit lands.
fn writer_loop<E>(
    conn: Connection,
    rx: Receiver<(TrackRecord, i64)>,
    input: ReconcileInput<'_>,
    scanned_at: i64,
    cancel: Arc<AtomicBool>,
    emit: &E,
) -> Result<WriterOutcome, String>
where
    E: Fn(ScanEmit) + Sync,
{
    let to_msg = |e: rusqlite::Error| e.to_string();

    conn.execute_batch("BEGIN").map_err(to_msg)?;
    let mut batch: Vec<i64> = Vec::new();
    while let Ok((rec, root_id)) = rx.recv() {
        batch.push(db::upsert_track(&conn, &rec, Some(root_id)).map_err(to_msg)?);
        if batch.len() as u32 >= WRITE_BATCH {
            conn.execute_batch("COMMIT; BEGIN").map_err(to_msg)?;
            emit(ScanEmit::Changed(std::mem::take(&mut batch)));
        }
    }
    conn.execute_batch("COMMIT").map_err(to_msg)?;
    if !batch.is_empty() {
        emit(ScanEmit::Changed(batch));
    }

    // A cancelled walk has an incomplete seen set, so flagging "unseen" rows would mark present
    // files missing. Only a complete pass reconciles.
    if cancel.load(Ordering::Relaxed) {
        return Ok((0, 0, Vec::new()));
    }
    // A drive pulled during the walk left that root's seen set partial: it leaves the scope.
    let (reachable, gone): (Vec<&Scope>, Vec<&Scope>) =
        input.scopes.iter().partition(|r| root_reachable(&r.path));
    let outcome = reconcile_presence(
        &conn,
        &input.seen,
        input.failed_dirs,
        scanned_at,
        &reachable,
    )
    .map_err(to_msg)?;
    if !outcome.changed.is_empty() {
        emit(ScanEmit::Changed(outcome.changed));
    }
    Ok((
        outcome.missing,
        outcome.returned,
        gone.iter().map(|r| r.id).collect(),
    ))
}

/// The tally of one reconcile, with the ids of every row it rewrote.
struct Reconciled {
    missing: u32,
    returned: u32,
    changed: Vec<i64>,
}

/// Reconciles each indexed row in the walked scopes against the seen map, never deleting (a delete
/// would orphan album membership). Rows are read by `root_id IN (walked ids)`, so scanning one root
/// never flags another root's rows, and a narrowed root keeps only the rows inside its units. A row
/// absent from disk and not yet flagged is stamped `missing_at = scanned_at`; a row back on disk that
/// still carries a stamp is cleared to NULL. The clear must happen here: a returned-unchanged file is
/// skipped by the incremental check, so its upsert never fires. A folder the walk could not read is
/// never taken as empty: a row at or under one of `failed_dirs` is never flagged, though clearing and
/// filling still apply to it. A legacy row with a NULL `display_path` is filled here too, from the
/// walk's real-case path, so no file is re-read to capture it.
fn reconcile_presence(
    conn: &Connection,
    seen: &HashMap<String, String>,
    failed_dirs: &[String],
    scanned_at: i64,
    scopes: &[&Scope],
) -> rusqlite::Result<Reconciled> {
    let mut outcome = Reconciled {
        missing: 0,
        returned: 0,
        changed: Vec::new(),
    };
    if scopes.is_empty() {
        return Ok(outcome);
    }

    let placeholders = scopes.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, source_path, missing_at, display_path, root_id FROM tracks \
         WHERE root_id IN ({placeholders})"
    );
    type Row = (i64, String, Option<i64>, Option<String>, i64);
    let rows: Vec<Row> = {
        let mut stmt = conn.prepare(&sql)?;
        let mapped = stmt.query_map(
            rusqlite::params_from_iter(scopes.iter().map(|s| s.id)),
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )?;
        mapped.collect::<rusqlite::Result<_>>()?
    };
    let units_of: HashMap<i64, &Option<Vec<UnitKey>>> =
        scopes.iter().map(|s| (s.id, &s.units)).collect();
    let rows: Vec<&Row> = rows
        .iter()
        .filter(|(_, path, _, _, root_id)| match units_of.get(root_id) {
            Some(Some(units)) => units.iter().any(|u| u.covers(path)),
            _ => true,
        })
        .collect();

    let to_flag: Vec<&Row> = rows
        .iter()
        .copied()
        .filter(|(_, path, missing_at, _, _)| {
            missing_at.is_none() && !seen.contains_key(path) && !under_failed_dir(path, failed_dirs)
        })
        .collect();
    let to_clear: Vec<&Row> = rows
        .iter()
        .copied()
        .filter(|(_, path, missing_at, _, _)| missing_at.is_some() && seen.contains_key(path))
        .collect();
    // A row still on disk whose display_path was never captured: fill it from the walk's real path.
    let to_fill: Vec<(&Row, &String)> = rows
        .iter()
        .copied()
        .filter(|(_, _, _, display, _)| display.is_none())
        .filter_map(|row| seen.get(&row.1).map(|real| (row, real)))
        .collect();

    if to_flag.is_empty() && to_clear.is_empty() && to_fill.is_empty() {
        return Ok(outcome);
    }

    conn.execute_batch("BEGIN")?;
    {
        let mut flag = conn.prepare("UPDATE tracks SET missing_at = ?1 WHERE source_path = ?2")?;
        for (_, path, _, _, _) in &to_flag {
            flag.execute(params![scanned_at, path])?;
        }
        let mut clear =
            conn.prepare("UPDATE tracks SET missing_at = NULL WHERE source_path = ?1")?;
        for (_, path, _, _, _) in &to_clear {
            clear.execute(params![path])?;
        }
        let mut fill =
            conn.prepare("UPDATE tracks SET display_path = ?1 WHERE source_path = ?2")?;
        for ((_, path, _, _, _), real) in &to_fill {
            fill.execute(params![real, path])?;
        }
    }
    conn.execute_batch("COMMIT")?;

    outcome.missing = to_flag.len() as u32;
    outcome.returned = to_clear.len() as u32;
    let mut changed: Vec<i64> = to_flag
        .iter()
        .chain(&to_clear)
        .map(|row| row.0)
        .chain(to_fill.iter().map(|(row, _)| row.0))
        .collect();
    changed.sort_unstable();
    changed.dedup();
    outcome.changed = changed;
    Ok(outcome)
}

/// Whether the canonical `key` is one of `failed_dirs` or lies beneath one.
fn under_failed_dir(key: &str, failed_dirs: &[String]) -> bool {
    failed_dirs.iter().any(|dir| under_dir(key, dir))
}

/// Whether the canonical `key` is `dir` or lies beneath it. The match stops at a path separator, so
/// `music/ab` does not cover `music/abc`.
pub(crate) fn under_dir(key: &str, dir: &str) -> bool {
    key.strip_prefix(dir).is_some_and(|rest| {
        rest.is_empty() || rest.starts_with(MAIN_SEPARATOR) || dir.ends_with(MAIN_SEPARATOR)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU32;

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("plisto_{tag}_{}_{n}_{nanos}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn no_progress(_e: ScanEmit) {}

    fn scan(root: &Path, db_path: &Path) -> ScanSummary {
        let cancel = Arc::new(AtomicBool::new(false));
        // Get-or-create the root row so the writer has an id to stamp, exactly as the command does.
        let id = {
            let conn = db::open_db(db_path).unwrap();
            db::get_or_create_root(&conn, &root.to_string_lossy(), 1000)
                .unwrap()
                .0
        };
        let roots = [ScanRoot {
            id,
            path: root.to_path_buf(),
            units: None,
        }];
        run_scan(&roots, db_path, &cancel, 1000, &HashMap::new(), no_progress).unwrap()
    }

    #[test]
    fn scans_audio_and_ignores_non_audio() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        // Empty files: lofty cannot parse them, so each is indexed as an error row.
        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();
        fs::write(music.path.join("notes.txt"), b"hello").unwrap();

        let sum = scan(&music.path, &db_path);
        assert_eq!(sum.total, 2, "only the two audio files count");
        assert_eq!(sum.seen, 2);
        assert_eq!(sum.inserted, 2);
        assert_eq!(sum.updated, 0);
        assert_eq!(sum.skipped, 0);
        assert_eq!(sum.removed, 0);
        assert_eq!(sum.errors, 2, "empty audio files are unparseable");
        assert!(!sum.cancelled);
    }

    #[test]
    fn rescan_unchanged_skips_everything() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();

        let first = scan(&music.path, &db_path);
        assert_eq!(first.inserted, 2);

        let second = scan(&music.path, &db_path);
        assert_eq!(second.skipped, 2, "unchanged files are skipped");
        assert_eq!(second.inserted, 0);
        assert_eq!(second.updated, 0);
        assert_eq!(second.removed, 0);
        assert_eq!(second.errors, 0, "skipped files are not re-read");
    }

    // The missing_at stamp for one filename, read straight from the db.
    fn missing_at_of(db_path: &Path, filename: &str) -> Option<i64> {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT missing_at FROM tracks WHERE filename = ?1",
            params![filename],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn vanished_file_is_flagged_missing_then_cleared_on_return() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();
        scan(&music.path, &db_path);

        // A deleted file keeps its row (album membership must not be orphaned): flagged, never
        // swept.
        fs::remove_file(music.path.join("b.flac")).unwrap();
        let gone = scan(&music.path, &db_path);
        assert_eq!(gone.total, 1);
        assert_eq!(gone.skipped, 1, "the surviving file is unchanged");
        assert_eq!(gone.removed, 0, "a scan never deletes");
        assert_eq!(gone.missing, 1, "the vanished file is flagged missing");
        assert_eq!(gone.returned, 0);
        assert!(
            missing_at_of(&db_path, "b.flac").is_some(),
            "the row survives with a missing stamp",
        );

        // A second pass while it is still gone does not re-stamp it.
        let still_gone = scan(&music.path, &db_path);
        assert_eq!(
            still_gone.missing, 0,
            "an existing stamp is not overwritten"
        );
        assert_eq!(still_gone.returned, 0);

        // Restoring the file clears the flag on the next pass.
        fs::write(music.path.join("b.flac"), b"").unwrap();
        let back = scan(&music.path, &db_path);
        assert_eq!(back.missing, 0);
        assert_eq!(back.returned, 1, "the returned file is cleared");
        assert_eq!(
            missing_at_of(&db_path, "b.flac"),
            None,
            "missing_at is back to NULL",
        );
    }

    #[test]
    fn scans_never_touch_the_export_record() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();
        scan(&music.path, &db_path);

        let rows = vec![
            ("Albums/X/Y/01 - A.mp3".to_string(), "f1".to_string()),
            ("Albums/X/Y/02 - B.flac".to_string(), "f2".to_string()),
        ];
        {
            let mut conn = db::open_db(&db_path).unwrap();
            db::record_export_files(&mut conn, "dest", &rows, 50).unwrap();
        }
        let record = || {
            let conn = db::open_db(&db_path).unwrap();
            (
                db::export_ledger(&conn, "dest").unwrap(),
                db::export_ledger_last(&conn, "dest").unwrap(),
            )
        };
        let before = record();

        // A vanished file, a new one, and a return: the record stays exactly as it was.
        fs::remove_file(music.path.join("b.flac")).unwrap();
        fs::write(music.path.join("c.mp3"), b"").unwrap();
        scan(&music.path, &db_path);
        assert_eq!(record(), before);
        fs::write(music.path.join("b.flac"), b"").unwrap();
        scan(&music.path, &db_path);
        assert_eq!(record(), before);
    }

    // Count rows on the db whose has_embedded_cover is still NULL.
    fn null_art_count(db_path: &Path) -> i64 {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM tracks WHERE has_embedded_cover IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn scan_drains_null_art_then_settles() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        // Empty files: lofty fails, so art is examined-as-none, non-NULL after the first scan.
        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();

        let first = scan(&music.path, &db_path);
        assert_eq!(first.inserted, 2);
        assert_eq!(null_art_count(&db_path), 0, "every fresh row is examined");

        // Reset one row to the drain sentinel, as a legacy row would read after the migration.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE tracks SET has_embedded_cover = NULL WHERE filename = 'a.mp3'",
                [],
            )
            .unwrap();
        }
        assert_eq!(null_art_count(&db_path), 1);

        // An unchanged re-scan re-reads only the NULL-art row and refills it.
        let second = scan(&music.path, &db_path);
        assert_eq!(second.updated, 1, "the NULL-art row is re-read");
        assert_eq!(second.skipped, 1, "the examined row is skipped");
        assert_eq!(second.inserted, 0);
        assert_eq!(null_art_count(&db_path), 0, "the sentinel is drained");

        // Now that every row is examined, an unchanged re-scan skips all of them.
        let third = scan(&music.path, &db_path);
        assert_eq!(third.skipped, 2);
        assert_eq!(third.updated, 0);
    }

    // The display_path stored for one filename, read straight from the db.
    fn display_path_of(db_path: &Path, filename: &str) -> Option<String> {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT display_path FROM tracks WHERE filename = ?1",
            params![filename],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn scan_captures_and_drains_display_path() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        // A mixed-case folder and file, so folding vs display is visible where the OS folds case.
        let sub = music.path.join("MixedCase");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("Song.Mp3");
        fs::write(&file, b"").unwrap();
        let real = file.to_string_lossy().into_owned();

        scan(&music.path, &db_path);
        assert_eq!(
            display_path_of(&db_path, "Song.Mp3").as_deref(),
            Some(real.as_str()),
            "the scan captures the file's real-case path",
        );

        // Reset display_path to the drain sentinel, as a legacy row reads after the migration.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE tracks SET display_path = NULL WHERE filename = 'Song.Mp3'",
                [],
            )
            .unwrap();
        }
        assert_eq!(display_path_of(&db_path, "Song.Mp3"), None);

        // An unchanged re-scan skips the file (its mtime is unchanged, so needs_reread is false and
        // the upsert never fires), yet the walk refills display_path in the seen pass.
        let second = scan(&music.path, &db_path);
        assert_eq!(second.skipped, 1, "the unchanged file is not re-read");
        assert_eq!(second.updated, 0);
        assert_eq!(
            display_path_of(&db_path, "Song.Mp3").as_deref(),
            Some(real.as_str()),
            "the drain refills display_path from the walk, not a tag re-read",
        );
    }

    #[test]
    fn scanning_one_root_does_not_flag_another_missing() {
        let a = TempDir::new("root_a");
        let b = TempDir::new("root_b");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        fs::write(a.path.join("a.mp3"), b"").unwrap();
        fs::write(b.path.join("b.mp3"), b"").unwrap();

        // Index both roots in one pass.
        let (id_a, id_b) = {
            let conn = db::open_db(&db_path).unwrap();
            let ida = db::get_or_create_root(&conn, &a.path.to_string_lossy(), 1)
                .unwrap()
                .0;
            let idb = db::get_or_create_root(&conn, &b.path.to_string_lossy(), 1)
                .unwrap()
                .0;
            (ida, idb)
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let both = [
            ScanRoot {
                id: id_a,
                path: a.path.clone(),
                units: None,
            },
            ScanRoot {
                id: id_b,
                path: b.path.clone(),
                units: None,
            },
        ];
        run_scan(&both, &db_path, &cancel, 1000, &HashMap::new(), no_progress).unwrap();

        // Rescan only root B. Root A is not walked, so its row must not be flagged missing even
        // though it is outside this pass's seen set.
        let only_b = [ScanRoot {
            id: id_b,
            path: b.path.clone(),
            units: None,
        }];
        run_scan(
            &only_b,
            &db_path,
            &cancel,
            2000,
            &HashMap::new(),
            no_progress,
        )
        .unwrap();

        assert_eq!(
            missing_at_of(&db_path, "a.mp3"),
            None,
            "root A's row is untouched by a root-B-only scan",
        );
        assert_eq!(
            missing_at_of(&db_path, "b.mp3"),
            None,
            "root B's file is present"
        );
    }

    // The id of the root row stored for `path`.
    fn root_id_of(db_path: &Path, path: &Path) -> i64 {
        let conn = db::open_db(db_path).unwrap();
        db::get_or_create_root(&conn, &path.to_string_lossy(), 1)
            .unwrap()
            .0
    }

    #[test]
    fn unreachable_root_is_offline_not_empty() {
        let base = TempDir::new("scan_offline");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let music = base.path.join("drive");
        fs::create_dir_all(&music).unwrap();
        fs::write(music.join("a.mp3"), b"").unwrap();
        fs::write(music.join("b.flac"), b"").unwrap();
        scan(&music, &db_path);
        let id = root_id_of(&db_path, &music);

        // The folder is gone, as an unplugged drive reads: nothing may be flagged missing.
        fs::remove_dir_all(&music).unwrap();
        let sum = scan(&music, &db_path);
        assert_eq!(sum.missing, 0, "an unreachable root is not taken as empty");
        assert_eq!(sum.total, 0);
        assert_eq!(sum.offline_roots, vec![id]);
        assert_eq!(missing_at_of(&db_path, "a.mp3"), None);
        assert_eq!(missing_at_of(&db_path, "b.flac"), None);
    }

    #[test]
    fn offline_root_does_not_block_reconcile_of_a_reachable_one() {
        let a = TempDir::new("root_a");
        let base = TempDir::new("scan_offline");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let b = base.path.join("drive");
        fs::create_dir_all(&b).unwrap();

        fs::write(a.path.join("a1.mp3"), b"").unwrap();
        fs::write(a.path.join("a2.mp3"), b"").unwrap();
        fs::write(b.join("b.mp3"), b"").unwrap();

        let id_a = root_id_of(&db_path, &a.path);
        let id_b = root_id_of(&db_path, &b);
        let cancel = Arc::new(AtomicBool::new(false));
        let both = [
            ScanRoot {
                id: id_a,
                path: a.path.clone(),
                units: None,
            },
            ScanRoot {
                id: id_b,
                path: b.clone(),
                units: None,
            },
        ];
        run_scan(&both, &db_path, &cancel, 1000, &HashMap::new(), no_progress).unwrap();

        fs::remove_file(a.path.join("a2.mp3")).unwrap();
        fs::remove_dir_all(&b).unwrap();
        let sum = run_scan(&both, &db_path, &cancel, 2000, &HashMap::new(), no_progress).unwrap();

        assert_eq!(
            sum.missing, 1,
            "only the file deleted from the reachable root"
        );
        assert_eq!(sum.offline_roots, vec![id_b]);
        assert_eq!(missing_at_of(&db_path, "a1.mp3"), None);
        assert_eq!(missing_at_of(&db_path, "a2.mp3"), Some(2000));
        assert_eq!(
            missing_at_of(&db_path, "b.mp3"),
            None,
            "the offline root is untouched"
        );
    }

    #[test]
    fn reconcile_leaves_failed_folders_unflagged() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let locked = music.path.join("locked");
        let sibling = music.path.join("sibling");
        fs::create_dir_all(&locked).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(locked.join("x.mp3"), b"").unwrap();
        fs::write(sibling.join("y.mp3"), b"").unwrap();
        scan(&music.path, &db_path);
        let id = root_id_of(&db_path, &music.path);

        // Neither file is in the seen set; only the one outside the failed folder is flagged.
        let failed = vec![normalize_path_key(&locked.to_string_lossy())];
        let conn = db::open_db(&db_path).unwrap();
        let scope = Scope {
            id,
            path: music.path.clone(),
            units: None,
        };
        let outcome = reconcile_presence(&conn, &HashMap::new(), &failed, 2000, &[&scope]).unwrap();
        assert_eq!(outcome.missing, 1);
        assert_eq!(
            missing_at_of(&db_path, "x.mp3"),
            None,
            "the unreadable folder is skipped"
        );
        assert_eq!(missing_at_of(&db_path, "y.mp3"), Some(2000));
    }

    #[test]
    fn failed_dir_match_stops_at_a_separator() {
        let s = MAIN_SEPARATOR;
        let failed = vec![format!("music{s}ab")];
        assert!(under_failed_dir(&format!("music{s}ab"), &failed));
        assert!(under_failed_dir(&format!("music{s}ab{s}t.mp3"), &failed));
        assert!(under_failed_dir(&format!("music{s}ab{s}x{s}t.mp3"), &failed));
        assert!(!under_failed_dir(&format!("music{s}abc{s}t.mp3"), &failed));
        assert!(!under_failed_dir(&format!("music{s}abc"), &failed));
        assert!(!under_failed_dir(&format!("music{s}t.mp3"), &failed));
        assert!(!under_failed_dir(&format!("music{s}ab{s}t.mp3"), &[]));

        // A drive-root key already ends in a separator.
        let drive = vec![format!("d:{s}")];
        assert!(under_failed_dir(&format!("d:{s}t.mp3"), &drive));
    }

    #[test]
    fn scan_stamps_each_track_with_its_root_id() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        fs::write(music.path.join("a.mp3"), b"").unwrap();

        scan(&music.path, &db_path);

        let conn = Connection::open(&db_path).unwrap();
        let stamped: Option<i64> = conn
            .query_row(
                "SELECT root_id FROM tracks WHERE filename = 'a.mp3'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let root_id: i64 = conn
            .query_row("SELECT id FROM roots", [], |r| r.get(0))
            .unwrap();
        assert_eq!(stamped, Some(root_id), "the track carries its root's id");
    }

    #[test]
    fn empty_workspace_indexes_nothing() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        let sum = scan(&music.path, &db_path);
        assert_eq!(sum.total, 0);
        assert_eq!(sum.seen, 0);
        assert_eq!(sum.inserted, 0);
        assert_eq!(sum.errors, 0);
    }

    #[test]
    fn scan_skips_plisto_temp_staging_files() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        fs::write(music.path.join("real.mp3"), b"").unwrap();
        // An export's leftover staging file carries a real audio extension; it must never be indexed.
        fs::write(music.path.join(".plisto-tmp-30 - Song.mp3"), b"").unwrap();

        let sum = scan(&music.path, &db_path);
        assert_eq!(sum.total, 1, "only the real file is walked; the staging file is skipped");
        assert_eq!(sum.inserted, 1);
    }

    // Runs a pass over `root` narrowed to `units`, returning the summary and every changed id.
    fn scan_units(root: &Path, db_path: &Path, units: Vec<ScanUnit>) -> (ScanSummary, Vec<i64>) {
        let id = root_id_of(db_path, root);
        let roots = [ScanRoot {
            id,
            path: root.to_path_buf(),
            units: Some(units),
        }];
        let cancel = Arc::new(AtomicBool::new(false));
        let changed = Mutex::new(Vec::new());
        let sum = run_scan(&roots, db_path, &cancel, 2000, &HashMap::new(), |e| {
            if let ScanEmit::Changed(ids) = e {
                changed.lock().unwrap().extend(ids);
            }
        })
        .unwrap();
        (sum, changed.into_inner().unwrap())
    }

    fn unit(dir: &Path, recursive: bool) -> ScanUnit {
        ScanUnit {
            dir: dir.to_path_buf(),
            recursive,
        }
    }

    // The row id stored for one filename.
    fn id_of(db_path: &Path, filename: &str) -> i64 {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT id FROM tracks WHERE filename = ?1",
            params![filename],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn scoped_pass_inserts_a_new_file_in_a_dirty_folder() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let album = music.path.join("album");
        fs::create_dir_all(&album).unwrap();
        fs::write(album.join("old.mp3"), b"").unwrap();
        scan(&music.path, &db_path);

        fs::write(album.join("new.mp3"), b"").unwrap();
        let (sum, changed) = scan_units(&music.path, &db_path, vec![unit(&album, false)]);
        assert_eq!(sum.total, 2, "only the dirty folder is walked");
        assert_eq!(sum.inserted, 1);
        assert_eq!(sum.skipped, 1);
        assert_eq!(changed, vec![id_of(&db_path, "new.mp3")]);
    }

    #[test]
    fn scoped_pass_flags_only_deletions_inside_its_units() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let dirty = music.path.join("dirty");
        let other = music.path.join("other");
        fs::create_dir_all(&dirty).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(dirty.join("a.mp3"), b"").unwrap();
        fs::write(other.join("b.mp3"), b"").unwrap();
        scan(&music.path, &db_path);

        fs::remove_file(dirty.join("a.mp3")).unwrap();
        fs::remove_file(other.join("b.mp3")).unwrap();
        let (sum, changed) = scan_units(&music.path, &db_path, vec![unit(&dirty, true)]);
        assert_eq!(sum.missing, 1);
        assert_eq!(missing_at_of(&db_path, "a.mp3"), Some(2000));
        assert_eq!(
            missing_at_of(&db_path, "b.mp3"),
            None,
            "a file of the same root outside the scope is not flagged",
        );
        assert_eq!(changed, vec![id_of(&db_path, "a.mp3")]);
    }

    #[test]
    fn non_recursive_unit_leaves_child_folders_alone() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let sub = music.path.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(music.path.join("top.mp3"), b"").unwrap();
        fs::write(sub.join("child.mp3"), b"").unwrap();
        scan(&music.path, &db_path);

        fs::remove_file(music.path.join("top.mp3")).unwrap();
        fs::remove_file(sub.join("child.mp3")).unwrap();
        fs::write(sub.join("fresh.mp3"), b"").unwrap();
        let (sum, _) = scan_units(&music.path, &db_path, vec![unit(&music.path, false)]);
        assert_eq!(sum.total, 0, "the child folder is not walked");
        assert_eq!(sum.inserted, 0);
        assert_eq!(sum.missing, 1);
        assert_eq!(missing_at_of(&db_path, "top.mp3"), Some(2000));
        assert_eq!(missing_at_of(&db_path, "child.mp3"), None);
    }

    #[test]
    fn a_deleted_unit_folder_flags_its_tracks() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let album = music.path.join("album");
        fs::create_dir_all(album.join("cd1")).unwrap();
        fs::write(album.join("cd1").join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("keep.mp3"), b"").unwrap();
        scan(&music.path, &db_path);

        // The folder is gone while its root is reachable: it was deleted, not unplugged.
        fs::remove_dir_all(&album).unwrap();
        let (sum, _) = scan_units(&music.path, &db_path, vec![unit(&album, true)]);
        assert!(sum.offline_roots.is_empty());
        assert_eq!(sum.missing, 1);
        assert_eq!(missing_at_of(&db_path, "a.mp3"), Some(2000));
        assert_eq!(missing_at_of(&db_path, "keep.mp3"), None);
    }

    #[test]
    fn unit_scope_matches_its_folder_or_subtree() {
        let s = MAIN_SEPARATOR;
        let flat = UnitKey {
            key: format!("music{s}ab"),
            recursive: false,
        };
        assert!(flat.covers(&format!("music{s}ab{s}t.mp3")));
        assert!(!flat.covers(&format!("music{s}ab{s}x{s}t.mp3")));
        assert!(!flat.covers(&format!("music{s}abc{s}t.mp3")));

        let deep = UnitKey {
            recursive: true,
            ..flat
        };
        assert!(deep.covers(&format!("music{s}ab{s}t.mp3")));
        assert!(deep.covers(&format!("music{s}ab{s}x{s}t.mp3")));
        assert!(!deep.covers(&format!("music{s}abc{s}t.mp3")));
    }
}
