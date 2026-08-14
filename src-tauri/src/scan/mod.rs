/*
 * The scan pipeline: walk the workspace once for its exact file count, read tags in parallel
 * with rayon, feed a bounded channel, and let a single writer thread own the write connection
 * and commit batched upserts. A dedicated thread samples an atomic counter and emits throttled
 * progress with a guaranteed terminal tick. Cancellation is an atomic flag checked between walk
 * entries and at the top of each worker, so a cancelled scan leaves a valid partial index and
 * never reconciles. A vanished file is flagged missing, never deleted, only after a complete
 * pass, and a returned file's flag is cleared there too.
 */

// -- Module Declarations --
mod progress;
mod tags;

// -- Library Imports --
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Receiver};
use rayon::prelude::*;
use rusqlite::{params, Connection};
use walkdir::WalkDir;

// -- Local Imports --
use crate::db;
use crate::dto::{ScanPhase, ScanProgress, ScanSummary};
use crate::model::TrackRecord;
use crate::normalize::{is_audio, needs_reread, normalize_path_key, normalize_track};
use progress::ProgressThrottle;
use tags::read_tags;

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

/// Runs a full scan of `root`, writing into the database at `db_path`. `cancel` stops the walk
/// and the workers; `scanned_at` stamps every row written this pass; `emit` receives throttled
/// progress ticks. Returns the counts once the writer has drained and (on a complete pass)
/// reconciled presence: vanished files flagged missing, returned files cleared.
pub fn run_scan<E>(
    root: &Path,
    db_path: &Path,
    cancel: &Arc<AtomicBool>,
    scanned_at: i64,
    emit: E,
) -> Result<ScanSummary, String>
where
    E: Fn(ScanProgress) + Sync,
{
    emit(ScanProgress {
        phase: ScanPhase::Enumerating,
        scanned: 0,
        total: 0,
        errors: 0,
        done: false,
    });

    // The writer's own connection: open_db applies the pragmas and ensures the schema, so a
    // fresh db_path is created here and an existing one is a no-op migration.
    let conn = db::open_db(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE meta SET workspace_root = ?1 WHERE id = 1",
        params![root.to_string_lossy()],
    )
    .map_err(|e| e.to_string())?;

    let stats_map = load_stats(&conn).map_err(|e| e.to_string())?;

    // One walk yields the exact total and the seen map (folded key -> real-case path) the sweep
    // needs, both to reconcile presence and to drain display_path.
    let (paths, seen) = enumerate(root, cancel);
    let total = paths.len() as u32;

    let scanned = AtomicUsize::new(0);
    let inserted = AtomicUsize::new(0);
    let updated = AtomicUsize::new(0);
    let skipped = AtomicUsize::new(0);
    let errors = AtomicUsize::new(0);
    let done = AtomicBool::new(false);

    let (tx, rx) = bounded::<TrackRecord>(CHANNEL_CAP);

    let (missing, returned) = std::thread::scope(|s| -> Result<(u32, u32), String> {
        // The progress emitter: samples the counters and emits throttled ticks until the walk
        // finishes, then fires the single terminal tick.
        let progress_handle = s.spawn(|| {
            let start = Instant::now();
            let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL_MS);
            loop {
                let is_done = done.load(Ordering::Relaxed);
                let now_ms = start.elapsed().as_millis() as u64;
                if throttle.should_emit(now_ms, is_done) {
                    emit(ScanProgress {
                        phase: if is_done {
                            ScanPhase::Done
                        } else {
                            ScanPhase::Reading
                        },
                        scanned: scanned.load(Ordering::Relaxed) as u32,
                        total,
                        errors: errors.load(Ordering::Relaxed) as u32,
                        done: is_done,
                    });
                }
                if is_done {
                    break;
                }
                std::thread::sleep(PROGRESS_POLL);
            }
        });

        // The single writer, owning the write connection.
        let writer_cancel = Arc::clone(cancel);
        let writer_handle = s.spawn(move || writer_loop(conn, rx, seen, scanned_at, writer_cancel));

        // Fan out the reads. Each worker classifies against the pre-scan stats, so the writer
        // stays a pure sink.
        paths.par_iter().for_each(|path| {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let path_str = path.to_string_lossy();
            let key = normalize_path_key(&path_str);
            let Some(stat) = file_stats(path) else {
                return;
            };

            if let Some((ssize, smtime, art_known)) = stats_map.get(&key) {
                if !needs_reread((*ssize, *smtime), stat, *art_known) {
                    scanned.fetch_add(1, Ordering::Relaxed);
                    skipped.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                updated.fetch_add(1, Ordering::Relaxed);
            } else {
                inserted.fetch_add(1, Ordering::Relaxed);
            }

            let (raw, is_err) = read_tags(path);
            if is_err {
                errors.fetch_add(1, Ordering::Relaxed);
            }
            let rec = normalize_track(&path_str, stat.0, stat.1, scanned_at, &raw);
            let _ = tx.send(rec);
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
    })
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

/// Walks `root` once, keeping only audio files. Returns the paths to read and a map from each
/// file's canonical key to its real-case path, for the sweep. Cancellation stops the walk, which
/// leaves the seen map partial and is why the sweep is skipped on cancel.
fn enumerate(root: &Path, cancel: &Arc<AtomicBool>) -> (Vec<PathBuf>, HashMap<String, String>) {
    let mut paths = Vec::new();
    let mut seen = HashMap::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if !entry.file_type().is_file() {
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
        seen.insert(normalize_path_key(&real), real);
        paths.push(path);
    }
    (paths, seen)
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

/// Drains the channel, committing batched upserts, then reconciles presence on a complete pass.
/// Owns its connection for the whole scan. Returns `(missing, returned)`.
fn writer_loop(
    conn: Connection,
    rx: Receiver<TrackRecord>,
    seen: HashMap<String, String>,
    scanned_at: i64,
    cancel: Arc<AtomicBool>,
) -> Result<(u32, u32), String> {
    let to_msg = |e: rusqlite::Error| e.to_string();

    conn.execute_batch("BEGIN").map_err(to_msg)?;
    let mut in_batch = 0u32;
    while let Ok(rec) = rx.recv() {
        db::upsert_track(&conn, &rec).map_err(to_msg)?;
        in_batch += 1;
        if in_batch >= WRITE_BATCH {
            conn.execute_batch("COMMIT; BEGIN").map_err(to_msg)?;
            in_batch = 0;
        }
    }
    conn.execute_batch("COMMIT").map_err(to_msg)?;

    // A cancelled walk has an incomplete seen set, so flagging "unseen" rows would mark present
    // files missing. Only a complete pass reconciles.
    if cancel.load(Ordering::Relaxed) {
        return Ok((0, 0));
    }
    reconcile_presence(&conn, &seen, scanned_at).map_err(to_msg)
}

/// Reconciles each indexed row against the seen map, never deleting (a delete would orphan album
/// membership). A row absent from disk and not yet flagged is stamped `missing_at = scanned_at`;
/// a row back on disk that still carries a stamp is cleared to NULL. The clear must happen here:
/// a returned-unchanged file is skipped by the incremental check, so its upsert never fires. A
/// legacy row with a NULL `display_path` is filled here too, from the walk's real-case path, so
/// no file is re-read to capture it. Returns `(missing, returned)`. Single active workspace, so
/// every row belongs to the current root.
fn reconcile_presence(
    conn: &Connection,
    seen: &HashMap<String, String>,
    scanned_at: i64,
) -> rusqlite::Result<(u32, u32)> {
    let rows: Vec<(String, Option<i64>, Option<String>)> = {
        let mut stmt = conn.prepare("SELECT source_path, missing_at, display_path FROM tracks")?;
        let mapped =
            stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)))?;
        mapped.collect::<rusqlite::Result<_>>()?
    };

    let to_flag: Vec<&String> = rows
        .iter()
        .filter(|(path, missing_at, _)| missing_at.is_none() && !seen.contains_key(path))
        .map(|(path, _, _)| path)
        .collect();
    let to_clear: Vec<&String> = rows
        .iter()
        .filter(|(path, missing_at, _)| missing_at.is_some() && seen.contains_key(path))
        .map(|(path, _, _)| path)
        .collect();
    // A row still on disk whose display_path was never captured: fill it from the walk's real path.
    let to_fill: Vec<(&String, &String)> = rows
        .iter()
        .filter(|(_, _, display)| display.is_none())
        .filter_map(|(path, _, _)| seen.get(path).map(|real| (path, real)))
        .collect();

    if to_flag.is_empty() && to_clear.is_empty() && to_fill.is_empty() {
        return Ok((0, 0));
    }

    conn.execute_batch("BEGIN")?;
    {
        let mut flag =
            conn.prepare("UPDATE tracks SET missing_at = ?1 WHERE source_path = ?2")?;
        for path in &to_flag {
            flag.execute(params![scanned_at, path])?;
        }
        let mut clear =
            conn.prepare("UPDATE tracks SET missing_at = NULL WHERE source_path = ?1")?;
        for path in &to_clear {
            clear.execute(params![path])?;
        }
        let mut fill =
            conn.prepare("UPDATE tracks SET display_path = ?1 WHERE source_path = ?2")?;
        for (path, real) in &to_fill {
            fill.execute(params![real, path])?;
        }
    }
    conn.execute_batch("COMMIT")?;
    Ok((to_flag.len() as u32, to_clear.len() as u32))
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
            let path = std::env::temp_dir().join(format!(
                "plisto_{tag}_{}_{n}_{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn no_progress(_p: ScanProgress) {}

    fn scan(root: &Path, db_path: &Path) -> ScanSummary {
        let cancel = Arc::new(AtomicBool::new(false));
        run_scan(root, db_path, &cancel, 1000, no_progress).unwrap()
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
        assert_eq!(still_gone.missing, 0, "an existing stamp is not overwritten");
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
}
