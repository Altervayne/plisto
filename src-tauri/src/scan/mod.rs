/*
 * The scan pipeline: walk the workspace once for its exact file count, read tags in parallel
 * with rayon, feed a bounded channel, and let a single writer thread own the write connection
 * and commit batched upserts. A dedicated thread samples an atomic counter and emits throttled
 * progress with a guaranteed terminal tick. Cancellation is an atomic flag checked between walk
 * entries and at the top of each worker, so a cancelled scan leaves a valid partial index and
 * never reconciles. A vanished file is flagged missing, never deleted, only after a complete
 * pass, and a returned file's flag is cleared there too. An unreachable root or an unreadable
 * folder is never taken as empty: its rows are left as they are. A root can be narrowed to a set of
 * units (folders, recursive or not); the walk and the reconcile then stay inside them. Writes to
 * music files left unfinished under a root are settled before it is walked.
 */

// -- Module Declarations --
mod deferral;
pub(crate) mod issues;
pub(crate) mod log;
pub mod progress;
pub(crate) mod retry;
mod tags;

// -- Library Imports --
use std::collections::HashMap;
use std::error::Error;
use std::io;
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
use crate::db::scan_issues::{apply_pass, load_issue_keys, Applied, IssueScope};
use crate::dto::{ScanPhase, ScanProgress, ScanSummary, WriteRecovery};
use crate::model::TrackRecord;
use crate::normalize::{folder_of, is_audio, needs_reread, normalize_path_key, normalize_track};
use deferral::{read_decision, share_locked, ReadDecision};
use issues::{classify, describe, IssueDraft, IssueKind};
use progress::ProgressThrottle;
use tags::read_tags_detailed;
// Re-exported so ad-hoc playback reads a lone file's tags through the same reader the scan uses.
pub(crate) use tags::{raw_from_art, read_tags};

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

/// What a scan reports while it runs: throttled progress ticks, the ids of rows it just committed
/// (upserted, or flagged or cleared by reconcile), one batch per commit, and what each root's
/// unfinished writes came to, for a root that had any.
pub enum ScanEmit {
    Progress(ScanProgress),
    Changed(Vec<i64>),
    Recovered(WriteRecovery),
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
/// `offline_roots`. Every file or folder that could not be read is recorded as a scan issue after
/// reconcile; `issues` is the count standing once the pass is written.
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
    run_scan_with(
        roots,
        db_path,
        cancel,
        scanned_at,
        deferred_since,
        emit,
        file_stats_checked,
    )
}

/// `run_scan` with the first stat of each file supplied, so a test can make it fail.
fn run_scan_with<E>(
    roots: &[ScanRoot],
    db_path: &Path,
    cancel: &Arc<AtomicBool>,
    scanned_at: i64,
    deferred_since: &HashMap<String, i64>,
    emit: E,
    stat_file: fn(&Path) -> io::Result<(i64, i64)>,
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
    let issue_keys = load_issue_keys(&conn).map_err(|e| e.to_string())?;

    // Walk each root once, tagging every path with its root id. `seen` (folded key -> real-case
    // path) is the union the sweep needs, both to reconcile presence and to drain display_path;
    // `scopes` is the reconcile scope and `failed_dirs` the folders inside it left unflagged.
    let mut work: Vec<(PathBuf, i64)> = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut failed_dirs: Vec<String> = Vec::new();
    let mut folder_issues: Vec<IssueDraft> = Vec::new();
    let mut scopes: Vec<Scope> = Vec::new();
    let mut offline_roots: Vec<i64> = Vec::new();
    for root in roots {
        let reachable = root_reachable(&root.path);
        // Unfinished writes are settled before the walk reads the files and reported before anything
        // can fail; an offline root's are counted as waiting. A reachable root that cannot be settled
        // sits this pass out, so a file mid-swap is never taken as gone.
        #[cfg(windows)]
        if let Err(e) = crate::file_writes::recover::recover_for_scan(
            &conn,
            root.id,
            &root.path,
            reachable,
            scanned_at,
            |found| emit(ScanEmit::Recovered(found)),
        ) {
            eprintln!("[scan] cannot recover writes under {}: {e}", root.path.display());
            if reachable {
                continue;
            }
        }
        // An unplugged drive or a deleted folder would walk as empty and flag every track missing.
        if !reachable {
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
        folder_issues.extend(walk.folder_issues);
        scopes.push(Scope::of(root));
    }
    let total = work.len() as u32;

    let scanned = AtomicUsize::new(0);
    let inserted = AtomicUsize::new(0);
    let updated = AtomicUsize::new(0);
    let skipped = AtomicUsize::new(0);
    let errors = AtomicUsize::new(0);
    let deferred: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let issues: Mutex<Vec<IssueDraft>> = Mutex::new(folder_issues);
    let healed: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let done = AtomicBool::new(false);

    let (tx, rx) = bounded::<(TrackRecord, i64)>(CHANNEL_CAP);

    let outcome = std::thread::scope(|s| -> Result<WriterOutcome, String> {
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
            issues: &issues,
            healed: &healed,
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
            let stat = match stat_file(path) {
                Ok(stat) => stat,
                Err(err) => {
                    // A file already recorded as unreadable keeps its `tags` row: a `stat` row would
                    // be swept on the next pass, which skips the unchanged file, and forget it.
                    let kind = if issue_keys.contains(&key) {
                        IssueKind::Tags
                    } else {
                        IssueKind::Stat
                    };
                    if let Some(draft) = issue_draft(kind, *root_id, path, key, &err) {
                        if let Ok(mut list) = issues.lock() {
                            list.push(draft);
                        }
                    }
                    // Counted so the pass still reaches its total.
                    scanned.fetch_add(1, Ordering::Relaxed);
                    return;
                }
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
            let read = (!locked).then(|| (read_tags_detailed(path), file_stats(path)));
            let after = read.as_ref().and_then(|(_, after)| *after);
            let since = deferred_since.get(&key).copied();
            if read_decision(locked, stat, after, since, scanned_at) == ReadDecision::Defer {
                if let Ok(mut list) = deferred.lock() {
                    list.push(path.clone());
                }
                scanned.fetch_add(1, Ordering::Relaxed);
                return;
            }
            let (raw, failure) = match read {
                Some((tags, _)) => tags,
                None => read_tags_detailed(path),
            };

            if known.is_some() {
                updated.fetch_add(1, Ordering::Relaxed);
            } else {
                inserted.fetch_add(1, Ordering::Relaxed);
            }
            match failure {
                Some(failure) => {
                    errors.fetch_add(1, Ordering::Relaxed);
                    if let (Some(reason), Ok(mut list)) = (failure.reason, issues.lock()) {
                        list.push(IssueDraft {
                            path: path_str.to_string(),
                            key,
                            root_id: *root_id,
                            kind: IssueKind::Tags,
                            reason,
                            detail: failure.detail,
                        });
                    }
                }
                None if issue_keys.contains(&key) => {
                    if let Ok(mut list) = healed.lock() {
                        list.push(key);
                    }
                }
                None => {}
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
    offline_roots.extend(outcome.gone);
    let deferred_paths = deferred.into_inner().unwrap_or_default();
    log::log_pass(db_path, &outcome.issues.changed);

    Ok(ScanSummary {
        total,
        seen: scanned.load(Ordering::Relaxed) as u32,
        inserted: inserted.load(Ordering::Relaxed) as u32,
        updated: updated.load(Ordering::Relaxed) as u32,
        skipped: skipped.load(Ordering::Relaxed) as u32,
        // Reserved for a future confirmation-gated purge; a scan never deletes.
        removed: 0,
        missing: outcome.missing,
        returned: outcome.returned,
        errors: errors.load(Ordering::Relaxed) as u32,
        cancelled: cancel.load(Ordering::Relaxed),
        offline_roots,
        deferred: deferred_paths.len() as u32,
        deferred_paths,
        issues: outcome.issues.total,
        issue_changes: outcome.issues.changed,
    })
}

/// The issue for a failed read of `path`, or None when the error is a missing file.
fn issue_draft(
    kind: IssueKind,
    root_id: i64,
    path: &Path,
    key: String,
    err: &(dyn Error + 'static),
) -> Option<IssueDraft> {
    Some(IssueDraft {
        path: path.to_string_lossy().into_owned(),
        key,
        root_id,
        kind,
        reason: classify(err)?,
        detail: describe(err),
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
/// `has_embedded_cover` and `raw_genres` are both non-NULL, which the re-read rule uses to drain
/// unexamined rows. A track flagged missing reads as not known, so it is re-read once when its file
/// returns and a still broken file gets its issue row back.
fn load_stats(conn: &Connection) -> rusqlite::Result<HashMap<String, (i64, i64, bool)>> {
    let mut stmt = conn.prepare(
        "SELECT source_path, size_bytes, mtime,
                has_embedded_cover IS NOT NULL AND raw_genres IS NOT NULL AND missing_at IS NULL
         FROM tracks",
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
/// the folders the walk could not read, with the issue recorded for each. `offline` is set when the
/// root itself could not be read.
struct Walk {
    paths: Vec<PathBuf>,
    seen: HashMap<String, String>,
    failed_dirs: Vec<String>,
    folder_issues: Vec<IssueDraft>,
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
        folder_issues: Vec::new(),
        offline: false,
    };
    match &root.units {
        None => walk_dir(&mut walk, root.id, &root.path, true, true, cancel),
        Some(units) => {
            for unit in units {
                walk_dir(&mut walk, root.id, &unit.dir, unit.recursive, false, cancel);
            }
        }
    }
    walk
}

/// Walks one folder into `walk`. A walk error is never taken as an empty folder: a failed subfolder
/// is recorded in `failed_dirs` so reconcile leaves its subtree alone. A failure on the folder itself
/// marks the whole root offline when it is the root; for a unit it is a failed folder, unless the
/// folder no longer exists at all, which inside a reachable root means it was deleted or moved away.
/// Each failed folder is also recorded as an issue of `root_id`; an offline root records none.
fn walk_dir(
    walk: &mut Walk,
    root_id: i64,
    dir: &Path,
    recursive: bool,
    is_root: bool,
    cancel: &AtomicBool,
) {
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
                    walk.folder_issues.extend(folder_issue(root_id, path, &err));
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
                        walk.folder_issues.extend(folder_issue(root_id, dir, &err));
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

/// The folder issue for a walk error at `dir`, classified from its OS error when it carries one.
fn folder_issue(root_id: i64, dir: &Path, err: &walkdir::Error) -> Option<IssueDraft> {
    let cause: &(dyn Error + 'static) = match err.io_error() {
        Some(io) => io,
        None => err,
    };
    issue_draft(IssueKind::Folder, root_id, dir, dir_key(dir), cause)
}

/// Reads a file's size and mtime. Returns None when the file cannot be stat'd, in which case
/// the worker leaves it out of this pass rather than indexing a row it cannot describe.
pub(crate) fn file_stats(path: &Path) -> Option<(i64, i64)> {
    file_stats_checked(path).ok()
}

/// Reads a file's size and mtime, with the error when the file cannot be stat'd.
pub(crate) fn file_stats_checked(path: &Path) -> io::Result<(i64, i64)> {
    let md = std::fs::metadata(path)?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok((md.len() as i64, mtime))
}

/// What the writer reports: the reconcile tally, the ids of walked roots found unreachable at
/// reconcile (`gone`), and the outcome of writing the pass's issues.
struct WriterOutcome {
    missing: u32,
    returned: u32,
    gone: Vec<i64>,
    issues: Applied,
}

/// What the writer reconciles against once the upserts drain: the walk's seen map, the folders it
/// could not read, and the scope of each walked root; then the issues the pass found and the
/// `tags` issue keys it read cleanly. Workers are done by the time the drain ends, so both lists
/// are complete when the writer takes them.
struct ReconcileInput<'a> {
    seen: HashMap<String, String>,
    failed_dirs: &'a [String],
    scopes: &'a [Scope],
    issues: &'a Mutex<Vec<IssueDraft>>,
    healed: &'a Mutex<Vec<String>>,
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

    let drafts = take_all(input.issues);
    let healed = take_all(input.healed);

    // A cancelled walk has an incomplete seen set, so flagging "unseen" rows would mark present
    // files missing. Only a complete pass reconciles, and only a complete pass sweeps issues.
    if cancel.load(Ordering::Relaxed) {
        // A root pulled mid-walk contributes no rows, as on a complete pass.
        let scopes: Vec<IssueScope> = input
            .scopes
            .iter()
            .filter(|s| root_reachable(&s.path))
            .map(issue_scope)
            .collect();
        let issues =
            apply_pass(&conn, &drafts, &healed, &scopes, false, scanned_at).map_err(to_msg)?;
        return Ok(WriterOutcome {
            missing: 0,
            returned: 0,
            gone: Vec::new(),
            issues,
        });
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
    // After reconcile, so the issue sweep sees the tracks it just flagged missing. A gone root is
    // left out: its drafts are dropped and its rows kept.
    let scopes: Vec<IssueScope> = reachable.iter().map(|s| issue_scope(s)).collect();
    let issues = apply_pass(&conn, &drafts, &healed, &scopes, true, scanned_at).map_err(to_msg)?;
    Ok(WriterOutcome {
        missing: outcome.missing,
        returned: outcome.returned,
        gone: gone.iter().map(|r| r.id).collect(),
        issues,
    })
}

/// A walked root's scope as the issue sweep takes it.
fn issue_scope(scope: &Scope) -> IssueScope<'_> {
    IssueScope {
        root_id: scope.id,
        units: scope.units.as_deref(),
    }
}

/// Empties a list the workers filled.
fn take_all<T>(list: &Mutex<Vec<T>>) -> Vec<T> {
    list.lock()
        .map(|mut l| std::mem::take(&mut *l))
        .unwrap_or_default()
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
    use std::sync::OnceLock;

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
        scan_at(root, db_path, 1000)
    }

    fn scan_at(root: &Path, db_path: &Path, scanned_at: i64) -> ScanSummary {
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
        run_scan(
            &roots,
            db_path,
            &cancel,
            scanned_at,
            &HashMap::new(),
            no_progress,
        )
        .unwrap()
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

    fn raw_genres_of(db_path: &Path, filename: &str) -> Option<String> {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT raw_genres FROM tracks WHERE filename = ?1",
            [filename],
            |r| r.get(0),
        )
        .unwrap()
    }

    // A FLAC that lofty opens, tagged with `genres` as separate GENRE values.
    fn write_flac_with_genres(path: &Path, genres: &[&str]) {
        use lofty::config::WriteOptions;
        use lofty::prelude::{ItemKey, TagExt};
        use lofty::tag::{ItemValue, Tag, TagItem, TagType};

        let mut flac = b"fLaC".to_vec();
        flac.push(0x80);
        flac.extend_from_slice(&[0x00, 0x00, 0x22]);
        flac.extend_from_slice(&[0u8; 34]);
        fs::write(path, flac).unwrap();
        let mut tag = Tag::new(TagType::VorbisComments);
        for genre in genres {
            tag.push(TagItem::new(ItemKey::Genre, ItemValue::Text((*genre).to_string())));
        }
        tag.save_to_path(path, WriteOptions::default()).unwrap();
    }

    #[test]
    fn a_scan_stores_one_genre_and_several_genres_as_arrays() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        write_flac_with_genres(&music.path.join("one.flac"), &["Rock"]);
        write_flac_with_genres(&music.path.join("many.flac"), &["Rock", "Pop; Soul", "Jazz"]);

        scan(&music.path, &db_path);

        assert_eq!(raw_genres_of(&db_path, "one.flac").as_deref(), Some(r#"["Rock"]"#));
        assert_eq!(
            raw_genres_of(&db_path, "many.flac").as_deref(),
            Some(r#"["Rock","Pop; Soul","Jazz"]"#)
        );
    }

    #[test]
    fn a_legacy_row_without_raw_genres_is_re_read_once() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();

        scan(&music.path, &db_path);
        assert_eq!(
            raw_genres_of(&db_path, "a.mp3").as_deref(),
            Some("[]"),
            "a file with no genre stores an empty list"
        );

        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE tracks SET raw_genres = NULL WHERE filename = 'a.mp3'",
                [],
            )
            .unwrap();
        }
        let second = scan(&music.path, &db_path);
        assert_eq!(second.updated, 1, "only the NULL row is re-read");
        assert_eq!(second.skipped, 1);
        assert_eq!(raw_genres_of(&db_path, "a.mp3").as_deref(), Some("[]"));

        let third = scan(&music.path, &db_path);
        assert_eq!(third.skipped, 2, "it is not read again");
        assert_eq!(third.updated, 0);
    }

    #[test]
    fn a_loudness_write_does_not_make_a_rescan_re_read() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();
        scan(&music.path, &db_path);

        // Stand in for the measurement writer: it fills the loudness group and nothing else.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE tracks SET loudness_lufs = -14.2, loudness_peak = 0.8,
                                   loudness_size = size_bytes, loudness_mtime = mtime",
                [],
            )
            .unwrap();
        }

        let again = scan(&music.path, &db_path);
        assert_eq!(again.total, 2);
        assert_eq!(again.skipped, again.total, "no row reads as changed");
        assert_eq!(again.updated, 0);
        assert_eq!(again.inserted, 0);
    }

    #[test]
    fn a_loudness_worker_visit_does_not_make_a_rescan_re_read() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");

        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.flac"), b"").unwrap();
        scan(&music.path, &db_path);

        // Rows indexed before the tag gains existed, so the visit runs the tags backfill and the stamp.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute("UPDATE tracks SET gain_tags_read = NULL", [])
                .unwrap();
            crate::loudness::test_support::visit_all(&conn);
            let stamped: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM tracks
                     WHERE gain_tags_read = 1 AND loudness_size = size_bytes
                       AND loudness_mtime = mtime",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stamped, 2);
        }

        let again = scan(&music.path, &db_path);
        assert_eq!(again.total, 2);
        assert_eq!(again.skipped, again.total, "no row reads as changed");
        assert_eq!(again.updated, 0);
        assert_eq!(again.inserted, 0);
    }

    // The art key stored for one filename, read straight from the db.
    fn art_key_of(db_path: &Path, filename: &str) -> (Option<String>, Option<i64>, Option<i64>) {
        let conn = Connection::open(db_path).unwrap();
        conn.query_row(
            "SELECT art_hash, art_width, art_height FROM tracks WHERE filename = ?1",
            params![filename],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    // Writes an MP4 carrying a `width` x `height` PNG cover and returns the PNG's bytes.
    fn mp4_with_cover(path: &Path, width: u32, height: u32) -> Vec<u8> {
        use crate::covers::test_support::{png_bytes, png_picture, write_mp4_with_pictures};
        let png = png_bytes(width, height);
        write_mp4_with_pictures(path, vec![png_picture(png.clone())]);
        png
    }

    #[test]
    fn scan_writes_the_art_key_of_new_and_changed_files() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let file = music.path.join("a.m4a");
        fs::write(music.path.join("b.mp3"), b"").unwrap();

        let png = mp4_with_cover(&file, 12, 6);
        scan(&music.path, &db_path);
        let hash = blake3::hash(&png).to_hex().to_string();
        assert_eq!(
            art_key_of(&db_path, "a.m4a"),
            (Some(hash), Some(12), Some(6))
        );
        assert_eq!(art_key_of(&db_path, "b.mp3"), (None, None, None));

        // A changed file is re-read and its key follows the new picture.
        let png = mp4_with_cover(&file, 20, 10);
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE tracks SET mtime = mtime - 1 WHERE filename = 'a.m4a'",
                [],
            )
            .unwrap();
        }
        let again = scan(&music.path, &db_path);
        assert_eq!(again.updated, 1);
        let hash = blake3::hash(&png).to_hex().to_string();
        assert_eq!(
            art_key_of(&db_path, "a.m4a"),
            (Some(hash), Some(20), Some(10))
        );
    }

    #[test]
    fn an_unknown_art_key_does_not_make_a_rescan_re_read() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        mp4_with_cover(&music.path.join("a.m4a"), 8, 8);
        fs::write(music.path.join("b.flac"), b"").unwrap();
        scan(&music.path, &db_path);

        // Rows indexed before the art key existed read it as unknown.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute(
                "UPDATE tracks SET art_hash = NULL, art_width = NULL, art_height = NULL",
                [],
            )
            .unwrap();
        }

        let again = scan(&music.path, &db_path);
        assert_eq!(again.total, 2);
        assert_eq!(again.skipped, again.total, "no row reads as changed");
        assert_eq!(again.updated, 0);
        assert_eq!(
            art_key_of(&db_path, "a.m4a"),
            (None, None, None),
            "the key is left to the first cover read"
        );
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

    // Every track's (filename, id), by filename.
    fn ids_by_name(db_path: &Path) -> Vec<(String, i64)> {
        let conn = Connection::open(db_path).unwrap();
        let mut stmt = conn
            .prepare("SELECT filename, id FROM tracks ORDER BY filename")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    #[test]
    fn a_moved_root_rescans_in_place_and_flags_only_the_absent_files() {
        let old = TempDir::new("scan_old");
        let new = TempDir::new("scan_new");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        fs::create_dir_all(old.path.join("sub")).unwrap();
        fs::write(old.path.join("a.mp3"), b"").unwrap();
        fs::write(old.path.join("sub").join("b.mp3"), b"").unwrap();
        fs::write(old.path.join("c.mp3"), b"").unwrap();
        scan(&old.path, &db_path);
        let before = ids_by_name(&db_path);
        let root_id = root_id_of(&db_path, &old.path);

        // The folder moved, and c.mp3 did not make the trip.
        fs::create_dir_all(new.path.join("sub")).unwrap();
        fs::write(new.path.join("a.mp3"), b"").unwrap();
        fs::write(new.path.join("sub").join("b.mp3"), b"").unwrap();
        {
            let mut conn = db::open_db(&db_path).unwrap();
            db::move_root(&mut conn, root_id, &new.path.to_string_lossy()).unwrap();
        }
        let roots = [ScanRoot {
            id: root_id,
            path: new.path.clone(),
            units: None,
        }];
        let cancel = Arc::new(AtomicBool::new(false));
        let sum = run_scan(
            &roots,
            &db_path,
            &cancel,
            2000,
            &HashMap::new(),
            no_progress,
        )
        .unwrap();

        assert_eq!(sum.inserted, 0, "the rewritten keys equal the walk's keys");
        assert_eq!(sum.missing, 1);
        assert_eq!(ids_by_name(&db_path), before, "every id survives");
        assert_eq!(missing_at_of(&db_path, "c.mp3"), Some(2000));
        assert_eq!(missing_at_of(&db_path, "a.mp3"), None);
        assert_eq!(missing_at_of(&db_path, "b.mp3"), None);
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

    // Every scan issue as (kind, path_key, first_seen), by key.
    fn issue_rows(db_path: &Path) -> Vec<(String, String, i64)> {
        let conn = Connection::open(db_path).unwrap();
        let mut stmt = conn
            .prepare("SELECT kind, path_key, first_seen FROM scan_issues ORDER BY path_key")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }

    fn key_of(path: &Path) -> String {
        normalize_path_key(&path.to_string_lossy())
    }

    // Records issues as an earlier pass over the whole root would have.
    fn seed_issues(db_path: &Path, root_id: i64, found: &[(IssueKind, &Path)]) {
        let drafts: Vec<IssueDraft> = found
            .iter()
            .map(|(kind, path)| IssueDraft {
                path: path.to_string_lossy().into_owned(),
                key: key_of(path),
                root_id,
                kind: *kind,
                reason: issues::Reason::Other,
                detail: String::new(),
            })
            .collect();
        let scope = IssueScope {
            root_id,
            units: None,
        };
        let conn = db::open_db(db_path).unwrap();
        apply_pass(&conn, &drafts, &[], &[scope], true, 500).unwrap();
    }

    // Fails the stat of `denied.mp3` as an access-denied error; every other file stats normally.
    fn denied_stat(path: &Path) -> io::Result<(i64, i64)> {
        if path.file_name().is_some_and(|n| n == "denied.mp3") {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        file_stats_checked(path)
    }

    // Runs one whole-root pass with `stat_file` in place of the real stat.
    fn scan_with_stat(
        root: &Path,
        db_path: &Path,
        cancel: &Arc<AtomicBool>,
        stat_file: fn(&Path) -> io::Result<(i64, i64)>,
        emit: impl Fn(ScanEmit) + Sync,
    ) -> ScanSummary {
        let roots = [ScanRoot {
            id: root_id_of(db_path, root),
            path: root.to_path_buf(),
            units: None,
        }];
        run_scan_with(
            &roots,
            db_path,
            cancel,
            2000,
            &HashMap::new(),
            emit,
            stat_file,
        )
        .unwrap()
    }

    #[test]
    fn an_unreadable_file_is_recorded_once_and_stands_until_it_reads() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let file = music.path.join("a.m4a");
        fs::write(&file, b"this is not audio").unwrap();

        let first = scan_at(&music.path, &db_path, 1000);
        assert_eq!((first.errors, first.issues), (1, 1));
        assert_eq!(first.issue_changes.len(), 1);
        assert!(first.issue_changes[0].is_new);
        assert_eq!(
            issue_rows(&db_path),
            vec![("tags".to_string(), key_of(&file), 1000)]
        );

        // The unchanged file is skipped, so the pass reads no error, yet the issue stands.
        let second = scan_at(&music.path, &db_path, 2000);
        assert_eq!((second.errors, second.issues), (0, 1));
        assert!(second.issue_changes.is_empty());
        assert_eq!(
            issue_rows(&db_path),
            vec![("tags".to_string(), key_of(&file), 1000)]
        );

        fs::write(&file, crate::covers::test_support::minimal_mp4()).unwrap();
        let fixed = scan_at(&music.path, &db_path, 3000);
        assert_eq!((fixed.updated, fixed.errors, fixed.issues), (1, 0, 0));
        assert!(issue_rows(&db_path).is_empty());
    }

    #[test]
    fn a_deleted_unreadable_file_loses_its_issue() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        fs::write(music.path.join("a.mp3"), b"").unwrap();
        fs::write(music.path.join("b.mp3"), b"").unwrap();
        assert_eq!(scan(&music.path, &db_path).issues, 2);

        fs::remove_file(music.path.join("b.mp3")).unwrap();
        let sum = scan_at(&music.path, &db_path, 2000);
        assert_eq!((sum.missing, sum.issues), (1, 1));
        assert_eq!(
            issue_rows(&db_path)
                .into_iter()
                .map(|(_, key, _)| key)
                .collect::<Vec<_>>(),
            vec![key_of(&music.path.join("a.mp3"))]
        );
    }

    #[test]
    fn a_failed_stat_is_recorded_and_still_counted_as_scanned() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let denied = music.path.join("denied.mp3");
        fs::write(&denied, b"").unwrap();
        fs::write(
            music.path.join("ok.m4a"),
            crate::covers::test_support::minimal_mp4(),
        )
        .unwrap();

        let last = Mutex::new(None);
        let cancel = Arc::new(AtomicBool::new(false));
        let sum = scan_with_stat(&music.path, &db_path, &cancel, denied_stat, |e| {
            if let ScanEmit::Progress(p) = e {
                *last.lock().unwrap() = Some((p.scanned, p.total, p.done));
            }
        });
        assert_eq!((sum.total, sum.seen, sum.inserted), (2, 2, 1));
        assert_eq!(last.into_inner().unwrap(), Some((2, 2, true)));
        assert_eq!(
            issue_rows(&db_path),
            vec![("stat".to_string(), key_of(&denied), 2000)]
        );
        let conn = db::open_db(&db_path).unwrap();
        let rows = db::scan_issues::list(&conn, 0, 10, None).unwrap();
        assert_eq!(rows[0].reason, "access_denied");

        // The next complete pass stats it fine and replaces the finding.
        let again = scan(&music.path, &db_path);
        assert_eq!(again.inserted, 1);
        assert!(issue_rows(&db_path).iter().all(|(kind, _, _)| kind != "stat"));
    }

    // The cancel flag the cancelling stat raises; only one test runs a pass with it.
    static STAT_CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();

    // Cancels the pass from inside its first stat, which then fails.
    fn cancelling_stat(_path: &Path) -> io::Result<(i64, i64)> {
        STAT_CANCEL
            .get_or_init(Default::default)
            .store(true, Ordering::SeqCst);
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    #[test]
    fn a_cancelled_pass_records_its_findings_and_sweeps_nothing() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let file = music.path.join("a.mp3");
        fs::write(&file, b"").unwrap();
        let id = root_id_of(&db_path, &music.path);
        let stale = music.path.join("old.mp3");
        let stale_dir = music.path.join("old");
        seed_issues(
            &db_path,
            id,
            &[(IssueKind::Stat, &stale), (IssueKind::Folder, &stale_dir)],
        );

        let cancel = Arc::clone(STAT_CANCEL.get_or_init(Default::default));
        let sum = scan_with_stat(&music.path, &db_path, &cancel, cancelling_stat, no_progress);
        assert!(sum.cancelled);
        assert_eq!(sum.issues, 3);
        assert_eq!(
            issue_rows(&db_path)
                .into_iter()
                .map(|(kind, key, _)| (kind, key))
                .collect::<Vec<_>>(),
            vec![
                ("stat".to_string(), key_of(&file)),
                ("folder".to_string(), key_of(&stale_dir)),
                ("stat".to_string(), key_of(&stale)),
            ]
        );
    }

    #[test]
    fn a_narrowed_pass_sweeps_only_inside_its_units() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let inside = music.path.join("in");
        let outside = music.path.join("out");
        fs::create_dir_all(&inside).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let id = root_id_of(&db_path, &music.path);
        seed_issues(
            &db_path,
            id,
            &[
                (IssueKind::Stat, &inside.join("a.mp3")),
                (IssueKind::Folder, &inside.join("sub")),
                (IssueKind::Stat, &outside.join("b.mp3")),
                (IssueKind::Folder, &outside.join("sub")),
            ],
        );

        let (sum, _) = scan_units(&music.path, &db_path, vec![unit(&inside, true)]);
        assert_eq!(sum.issues, 2);
        assert_eq!(
            issue_rows(&db_path)
                .into_iter()
                .map(|(_, key, _)| key)
                .collect::<Vec<_>>(),
            vec![key_of(&outside.join("b.mp3")), key_of(&outside.join("sub"))]
        );
    }

    #[test]
    fn a_folder_issue_is_classified_and_clears_once_the_folder_reads() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let locked = music.path.join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("x.m4a"), crate::covers::test_support::minimal_mp4()).unwrap();
        let id = root_id_of(&db_path, &music.path);

        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        let draft = issue_draft(IssueKind::Folder, id, &locked, dir_key(&locked), &denied)
            .expect("a denied folder is an issue");
        assert_eq!((draft.kind, draft.reason), (IssueKind::Folder, issues::Reason::AccessDenied));
        assert_eq!(draft.key, key_of(&locked));
        let gone = io::Error::from(io::ErrorKind::NotFound);
        assert!(issue_draft(IssueKind::Folder, id, &locked, dir_key(&locked), &gone).is_none());

        seed_issues(&db_path, id, &[(IssueKind::Folder, &locked)]);
        let sum = scan(&music.path, &db_path);
        assert_eq!((sum.inserted, sum.issues), (1, 0));
        assert!(issue_rows(&db_path).is_empty());
    }

    // Removes the folder holding the file, as a drive pulled mid-pass, then fails the stat.
    fn unplugging_stat(path: &Path) -> io::Result<(i64, i64)> {
        if let Some(root) = path.parent() {
            let _ = fs::remove_dir_all(root);
        }
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    #[test]
    fn an_unreachable_root_records_nothing_and_keeps_its_issues() {
        let base = TempDir::new("scan_offline");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let music = base.path.join("drive");
        fs::create_dir_all(&music).unwrap();
        let file = music.join("a.mp3");
        fs::write(&file, b"").unwrap();
        assert_eq!(scan(&music, &db_path).issues, 1);
        let id = root_id_of(&db_path, &music);
        let before = issue_rows(&db_path);

        // Unplugged between the walk and reconcile: the stat failure it caused is dropped.
        let cancel = Arc::new(AtomicBool::new(false));
        let sum = scan_with_stat(&music, &db_path, &cancel, unplugging_stat, no_progress);
        assert_eq!(sum.offline_roots, vec![id]);
        assert_eq!(sum.issues, 1);
        assert!(sum.issue_changes.is_empty());
        assert_eq!(issue_rows(&db_path), before);

        // Unreachable before the walk: nothing is walked and nothing is swept.
        let sum = scan_at(&music, &db_path, 3000);
        assert_eq!((sum.offline_roots, sum.issues), (vec![id], 1));
        assert_eq!(issue_rows(&db_path), before);
    }

    // The cancel flag the unplugging, cancelling stat raises; only one test runs a pass with it.
    static UNPLUG_CANCEL: OnceLock<Arc<AtomicBool>> = OnceLock::new();

    fn unplugging_cancelling_stat(path: &Path) -> io::Result<(i64, i64)> {
        UNPLUG_CANCEL
            .get_or_init(Default::default)
            .store(true, Ordering::SeqCst);
        unplugging_stat(path)
    }

    #[test]
    fn a_cancelled_pass_drops_the_findings_of_a_root_pulled_mid_walk() {
        let base = TempDir::new("scan_offline");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let music = base.path.join("drive");
        fs::create_dir_all(&music).unwrap();
        fs::write(music.join("a.mp3"), b"").unwrap();
        assert_eq!(scan(&music, &db_path).issues, 1);
        let before = issue_rows(&db_path);

        let cancel = Arc::clone(UNPLUG_CANCEL.get_or_init(Default::default));
        let sum = scan_with_stat(&music, &db_path, &cancel, unplugging_cancelling_stat, no_progress);
        assert!(sum.cancelled);
        assert!(sum.issue_changes.is_empty());
        assert_eq!(issue_rows(&db_path), before);
    }

    #[test]
    fn a_tags_row_survives_a_pass_whose_stat_fails() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let denied = music.path.join("denied.mp3");
        fs::write(&denied, b"").unwrap();
        assert_eq!(scan(&music.path, &db_path).issues, 1);

        let cancel = Arc::new(AtomicBool::new(false));
        scan_with_stat(&music.path, &db_path, &cancel, denied_stat, no_progress);
        let again = scan(&music.path, &db_path);

        assert_eq!(again.issues, 1);
        let conn = db::open_db(&db_path).unwrap();
        let rows = db::scan_issues::list(&conn, 0, 10, None).unwrap();
        assert_eq!(rows[0].kind, "tags");
        assert!(rows[0].track_id.is_some());
    }

    #[test]
    fn a_broken_file_that_goes_missing_and_returns_gets_its_issue_back() {
        let music = TempDir::new("scan_music");
        let store = TempDir::new("scan_db");
        let db_path = store.path.join("plisto.sqlite");
        let file = music.path.join("a.mp3");
        fs::write(&file, b"").unwrap();
        assert_eq!(scan_at(&music.path, &db_path, 1000).issues, 1);

        // Moved out and back, so its size and mtime are unchanged.
        let held = store.path.join("held.mp3");
        fs::rename(&file, &held).unwrap();
        let gone = scan_at(&music.path, &db_path, 2000);
        assert_eq!((gone.missing, gone.issues), (1, 0));

        fs::rename(&held, &file).unwrap();
        let back = scan_at(&music.path, &db_path, 3000);
        assert_eq!((back.returned, back.errors, back.issues), (1, 1, 1));
    }
}
