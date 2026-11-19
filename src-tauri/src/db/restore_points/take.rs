/*
 * Taking a point. The point file is attached to a library connection (ATTACH is refused inside a
 * transaction, so it comes first), then one read transaction copies every captured table with
 * INSERT...SELECT. Its first read pins the snapshot, so a point can be staged on one thread and
 * finished on another while the library takes new writes. Only the attached file is ever written. It
 * is built as `.tmp` and renamed once detached; any failure removes the `.tmp`, and the ring is pruned
 * only after a rename succeeded.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use rusqlite::{params, Connection};

// -- Local Imports --
use super::format::{
    content_hash, file_name, identity_path, is_tmp_name, tmp_name, DataTable, Reason, DATA_TABLES,
    FORMAT_VERSION, SCHEMA, SCHEMA_SQL,
};
use super::point_files;
use super::retention::{prune, Pruned};
use crate::db::{ALBUM_KIND, SINGLE_KIND};

// The `.tmp` files being written in this process, so a concurrent take never sweeps one away as
// stray, whatever the OS would allow.
static IN_FLIGHT: Mutex<Vec<Flight>> = Mutex::new(Vec::new());

impl Drop for InFlight {
    fn drop(&mut self) {
        let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
        in_flight.retain(|f| f != &self.0);
    }
}

/// A written point.
#[derive(Debug)]
pub struct Taken {
    pub file: String,
    /// Unix ms: the take's clock, or one past its ring's newest point when the clock reads earlier.
    /// Read by the tests only, like `content_hash`.
    #[allow(dead_code)]
    pub created_at: i64,
    pub bytes: u64,
    /// From the start of the take to the rename.
    pub ms: u64,
    #[allow(dead_code)]
    pub content_hash: String,
    /// The ring's pruning after the write. A failure here leaves the point in place.
    pub pruned: Result<Pruned, String>,
}

/// A point that was not written. Anything partly written is already removed.
#[derive(Debug)]
pub struct PointError {
    pub ms: u64,
    pub error: String,
}

impl std::fmt::Display for PointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.error)
    }
}

/// A point whose snapshot is pinned and whose file is attached, waiting for `finish`. Owns its
/// connection so it can move to a worker thread. Dropped unfinished, it removes its `.tmp`.
pub struct Staged {
    conn: Connection,
    pending: Option<Pending>,
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.take() {
            abort(&self.conn, &pending, true);
        }
    }
}

// What one take was asked for.
pub(super) struct Job<'a> {
    pub dir: &'a Path,
    pub reason: Reason,
    pub detail: Option<&'a str>,
    pub now_ms: i64,
    // A page cap on the point file; None leaves SQLite's own limit.
    pub max_pages: Option<u32>,
}

// A begun take: the names it writes under and what its meta row records.
struct Pending {
    dir: PathBuf,
    reason: Reason,
    detail: Option<String>,
    created_at: i64,
    tmp: PathBuf,
    dest: PathBuf,
    started: Instant,
    _in_flight: InFlight,
}

impl Pending {
    fn fail(&self, error: impl ToString) -> PointError {
        PointError {
            ms: self.started.elapsed().as_millis() as u64,
            error: error.to_string(),
        }
    }
}

// One `.tmp` being written: its canonical folder, ring, name time and path.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Flight {
    dir: PathBuf,
    reason: Reason,
    created_at: i64,
    tmp: PathBuf,
}

/// Holds a `.tmp` in the in-flight set until dropped.
pub(super) struct InFlight(Flight);

/// Writes a point of the library on `conn` into `dir` and prunes its ring. None when every captured
/// table is empty, in which case nothing is written. `conn` must have no open transaction.
pub fn take(
    conn: &Connection,
    dir: &Path,
    reason: Reason,
    detail: Option<&str>,
    now_ms: i64,
) -> Result<Option<Taken>, PointError> {
    take_job(
        conn,
        &Job {
            dir,
            reason,
            detail,
            now_ms,
            max_pages: None,
        },
    )
}

pub(super) fn take_job(conn: &Connection, job: &Job) -> Result<Option<Taken>, PointError> {
    match begin(conn, job)? {
        Some(pending) => complete(conn, pending).map(Some),
        None => Ok(None),
    }
}

/// Attaches the point file and pins the snapshot on `conn`, a connection of its own. The copy runs
/// in `finish`, on whichever thread holds the result. None when every captured table is empty.
pub fn stage(
    conn: Connection,
    dir: &Path,
    reason: Reason,
    detail: Option<&str>,
    now_ms: i64,
) -> Result<Option<Staged>, PointError> {
    let job = Job {
        dir,
        reason,
        detail,
        now_ms,
        max_pages: None,
    };
    Ok(begin(&conn, &job)?.map(|pending| Staged {
        conn,
        pending: Some(pending),
    }))
}

/// Copies a staged point from its pinned snapshot, renames it into place and prunes its ring.
pub fn finish(mut staged: Staged) -> Result<Taken, PointError> {
    let pending = staged
        .pending
        .take()
        .expect("a staged point holds its pending take until finished");
    complete(&staged.conn, pending)
}

// Up to the pinned snapshot: the empty check, the names, the attach, the schema and the first read.
// A caller's open transaction is refused before anything runs, so it is never touched.
fn begin(conn: &Connection, job: &Job) -> Result<Option<Pending>, PointError> {
    let started = Instant::now();
    let early = |error: String| PointError {
        ms: started.elapsed().as_millis() as u64,
        error,
    };
    if !conn.is_autocommit() {
        return Err(early(
            "a restore point cannot be taken inside an open transaction".to_string(),
        ));
    }
    if library_is_empty(conn).map_err(|e| early(e.to_string()))? {
        return Ok(None);
    }
    let dir = point_dir(job.dir).map_err(|e| early(e.to_string()))?;
    let (created_at, in_flight) = claim_names(&dir, job.reason, job.now_ms);
    let pending = Pending {
        reason: job.reason,
        detail: job.detail.map(str::to_string),
        created_at,
        tmp: in_flight.0.tmp.clone(),
        dest: dir.join(file_name(created_at, job.reason)),
        dir,
        started,
        _in_flight: in_flight,
    };
    if let Err(e) = attach(conn, &pending.tmp, job.max_pages) {
        abort(conn, &pending, false);
        return Err(pending.fail(e));
    }
    if let Err(e) = conn.execute_batch("BEGIN DEFERRED") {
        abort(conn, &pending, false);
        return Err(pending.fail(e));
    }
    // The first read of `main` fixes the snapshot every later read of this transaction sees.
    if let Err(e) = conn.query_row("SELECT COUNT(*) FROM main.albums", [], |r| r.get::<_, i64>(0)) {
        abort(conn, &pending, true);
        return Err(pending.fail(e));
    }
    Ok(Some(pending))
}

// From the pinned snapshot to a renamed file and a pruned ring.
fn complete(conn: &Connection, pending: Pending) -> Result<Taken, PointError> {
    let hash = match write(conn, &pending) {
        Ok(hash) => hash,
        Err(e) => {
            abort(conn, &pending, true);
            return Err(pending.fail(e));
        }
    };
    if let Err(e) = detach(conn) {
        abort(conn, &pending, false);
        return Err(pending.fail(e));
    }
    if let Err(e) = std::fs::rename(&pending.tmp, &pending.dest) {
        let _ = std::fs::remove_file(&pending.tmp);
        return Err(pending.fail(e));
    }
    let bytes = std::fs::metadata(&pending.dest).map_or(0, |m| m.len());
    let ms = pending.started.elapsed().as_millis() as u64;
    let pruned = prune(&pending.dir, pending.reason).map_err(|e| e.to_string());
    Ok(Taken {
        file: file_name(pending.created_at, pending.reason),
        created_at: pending.created_at,
        bytes,
        ms,
        content_hash: hash,
        pruned,
    })
}

// Every captured table empty: nothing a point could bring back.
fn library_is_empty(conn: &Connection) -> rusqlite::Result<bool> {
    let any = DATA_TABLES
        .iter()
        .map(|t| format!("EXISTS (SELECT 1 FROM main.{})", t.name))
        .collect::<Vec<_>>()
        .join(" OR ");
    let found: bool = conn.query_row(&format!("SELECT {any}"), [], |r| r.get(0))?;
    Ok(!found)
}

/// The points folder, created if needed, as its one canonical spelling. Every path a take writes,
/// sweeps or guards is built from this, so two spellings of one folder never miss each other.
pub(super) fn point_dir(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    dunce::canonicalize(dir)
}

// Sweeps stray `.tmp` files, then picks a creation time whose names are free and registers its
// `.tmp`. The time is `now_ms` or one past the newest point of the ring, finished or in flight,
// whichever is later: a clock set back never names the new point older than the ring, so the ring
// orders by writing and the new point is never the one pruned. A directory squatting the final name
// is left to fail the rename. `dir` is canonical.
pub(super) fn claim_names(dir: &Path, reason: Reason, now_ms: i64) -> (i64, InFlight) {
    let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let stray = entry.file_name().to_str().is_some_and(is_tmp_name)
                && !in_flight.iter().any(|f| f.tmp == path);
            if stray {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    let newest = point_files(dir)
        .unwrap_or_default()
        .iter()
        .filter(|p| p.reason == reason)
        .map(|p| p.created_at)
        .chain(
            in_flight
                .iter()
                .filter(|f| f.dir == dir && f.reason == reason)
                .map(|f| f.created_at),
        )
        .max();
    let mut created_at = newest.map_or(now_ms, |n| now_ms.max(n + 1));
    loop {
        let tmp = dir.join(tmp_name(created_at, reason));
        let taken = dir.join(file_name(created_at, reason)).is_file()
            || tmp.exists()
            || in_flight.iter().any(|f| f.tmp == tmp);
        if !taken {
            let flight = Flight {
                dir: dir.to_path_buf(),
                reason,
                created_at,
                tmp,
            };
            in_flight.push(flight.clone());
            return (created_at, InFlight(flight));
        }
        created_at += 1;
    }
}

fn attach(conn: &Connection, tmp: &Path, max_pages: Option<u32>) -> rusqlite::Result<()> {
    let attached: bool = conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_database_list WHERE name = ?1)",
        params![SCHEMA],
        |r| r.get(0),
    )?;
    if attached {
        detach(conn)?;
    }
    let path = tmp.to_str().ok_or_else(|| {
        rusqlite::Error::InvalidPath(tmp.to_path_buf())
    })?;
    conn.execute(&format!("ATTACH ?1 AS {SCHEMA}"), params![path])?;
    // The file is discarded on any failure, so its journal never needs to outlive a crash.
    conn.query_row(
        &format!("PRAGMA {SCHEMA}.journal_mode = MEMORY"),
        [],
        |_| Ok(()),
    )?;
    // One transaction on the attached file, committed before the snapshot begins, so the tables are
    // not created one autocommit at a time.
    conn.execute_batch(&format!("BEGIN;\n{SCHEMA_SQL}\nCOMMIT;"))
        .inspect_err(|_| {
            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
        })?;
    if let Some(pages) = max_pages {
        conn.query_row(
            &format!("PRAGMA {SCHEMA}.max_page_count = {pages}"),
            [],
            |_| Ok(()),
        )?;
    }
    Ok(())
}

fn detach(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!("DETACH DATABASE {SCHEMA}"))
}

// Rolls back the transaction `begin` opened when `own_tx`, detaches and removes the `.tmp`, each
// best-effort.
fn abort(conn: &Connection, pending: &Pending, own_tx: bool) {
    if own_tx && !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    let _ = detach(conn);
    let _ = std::fs::remove_file(&pending.tmp);
}

// The copy inside the pinned transaction: data tables, identity rows, meta, then the commit. Returns
// the content hash.
fn write(conn: &Connection, pending: &Pending) -> rusqlite::Result<String> {
    for table in DATA_TABLES {
        let columns = table.columns.join(", ");
        conn.execute(
            &format!(
                "INSERT INTO {SCHEMA}.{name} ({columns}) SELECT {columns} FROM main.{name}",
                name = table.name
            ),
            [],
        )?;
    }
    conn.execute(
        &format!(
            "INSERT INTO {SCHEMA}.roots (id, path, root_key) SELECT id, path, root_key FROM main.roots"
        ),
        [],
    )?;
    write_track_identities(conn)?;
    conn.execute(
        &format!(
            "INSERT INTO {SCHEMA}.covers (id, content_hash)
             SELECT id, content_hash FROM main.covers WHERE id IN ({})",
            referenced(|t| t.cover_column)
        ),
        [],
    )?;

    let count = |sql: String| -> rusqlite::Result<i64> { conn.query_row(&sql, [], |r| r.get(0)) };
    let albums = count(format!(
        "SELECT COUNT(*) FROM {SCHEMA}.albums WHERE kind = '{ALBUM_KIND}'"
    ))?;
    let singles = count(format!(
        "SELECT COUNT(*) FROM {SCHEMA}.albums WHERE kind = '{SINGLE_KIND}'"
    ))?;
    let playlists = count(format!("SELECT COUNT(*) FROM {SCHEMA}.playlists"))?;
    let filed_tracks = count(format!("SELECT COUNT(*) FROM {SCHEMA}.album_tracks"))?;
    let edited_tracks = count(format!("SELECT COUNT(*) FROM {SCHEMA}.track_edits"))?;
    let genre_tracks = count(format!(
        "SELECT COUNT(DISTINCT track_id) FROM {SCHEMA}.track_genres"
    ))?;
    let schema_version: i64 = conn.query_row("PRAGMA main.user_version", [], |r| r.get(0))?;
    let hash = content_hash(conn, SCHEMA)?;

    conn.execute(
        &format!(
            "INSERT INTO {SCHEMA}.meta (
                id, format, app_version, schema_version, created_at, reason, detail, albums, singles,
                playlists, filed_tracks, edited_tracks, genre_tracks, content_hash
             ) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
        ),
        params![
            FORMAT_VERSION,
            env!("CARGO_PKG_VERSION"),
            schema_version,
            pending.created_at,
            pending.reason.as_str(),
            pending.detail,
            albums,
            singles,
            playlists,
            filed_tracks,
            edited_tracks,
            genre_tracks,
            hash,
        ],
    )?;
    conn.execute_batch("COMMIT")?;
    Ok(hash)
}

// One identity row per track the copied tables name, holding its path once (see `identity_path`).
fn write_track_identities(conn: &Connection) -> rusqlite::Result<()> {
    let roots: HashMap<i64, String> = conn
        .prepare("SELECT id, path FROM main.roots")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut read = conn.prepare(&format!(
        "SELECT id, root_id, source_path, display_path, size_bytes, duration_secs FROM main.tracks
         WHERE id IN ({})",
        referenced(|t| t.track_column)
    ))?;
    let mut insert = conn.prepare(&format!(
        "INSERT INTO {SCHEMA}.tracks (id, root_id, rel_path, path_key, size_bytes, duration_secs)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ))?;
    let mut rows = read.query([])?;
    while let Some(row) = rows.next()? {
        let root_id: Option<i64> = row.get(1)?;
        let source_path: String = row.get(2)?;
        let display_path: Option<String> = row.get(3)?;
        let root_path = root_id.and_then(|id| roots.get(&id)).map(String::as_str);
        let (rel_path, path_key) =
            identity_path(root_path, &source_path, display_path.as_deref());
        insert.execute(params![
            row.get::<_, i64>(0)?,
            root_id,
            rel_path,
            path_key,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<f64>>(5)?,
        ])?;
    }
    Ok(())
}

// The ids one kind of reference names across the copied tables, as a UNION subquery over the point.
fn referenced(column: impl Fn(&DataTable) -> Option<&'static str>) -> String {
    DATA_TABLES
        .iter()
        .filter_map(|t| {
            column(t).map(|c| format!("SELECT {c} FROM {SCHEMA}.{} WHERE {c} IS NOT NULL", t.name))
        })
        .collect::<Vec<_>>()
        .join(" UNION ")
}

/// The content hash of the library on `conn`, read in one transaction and writing nothing. Equal to
/// a point's `content_hash` when nothing captured changed since it was taken.
pub fn live_hash(conn: &Connection) -> rusqlite::Result<String> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Deferred)?;
    let hash = content_hash(&tx, "main")?;
    tx.rollback()?;
    Ok(hash)
}
