/*
 * Retrying recorded read issues outside a scan. A `tags` or `stat` row is re-read file by file in
 * chunks, ignoring the size and modified-time skip: the file is stat'd, read, and upserted as the scan
 * would, then its row is cleared or refreshed. A `folder` row runs a scan narrowed to that folder, whose
 * sweep replaces the row. A file that has vanished clears its row. A root that cannot be listed is left
 * alone, so a pulled drive keeps its rows. The caller holds the scan lock.
 */

// -- Library Imports --
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rusqlite::Connection;

// -- Local Imports --
use super::issues::{IssueDraft, IssueKind};
use super::log::log_pass;
use super::tags::{read_tags_detailed, TagFailure};
use super::{
    file_stats_checked, issue_draft, root_reachable, run_scan, ScanEmit, ScanRoot, ScanUnit,
};
use crate::db;
use crate::db::scan_issues::{apply_pass, by_ids, count, IssueScope};
use crate::dto::{ScanIssue, ScanIssueRetryResult};
use crate::normalize::{normalize_path_key, normalize_track};

/// Files re-read per transaction.
const RETRY_CHUNK: usize = 200;

/// Each root's path when it exists and can be listed, else None, so it is looked up once per retry.
type RootPaths = HashMap<i64, Option<PathBuf>>;

/// Retries the issues named by `ids` (an id with no row is skipped) and reports how many were retried,
/// how many of those no longer stand, and how many rows remain in the whole table. `now` stamps the
/// rows and tracks written. `cancel` stops between chunks and between folder scans; what was not
/// reached keeps its row. Changed track ids go out through `emit` once each commit lands.
pub fn retry_issues<E>(
    db_path: &Path,
    cancel: &Arc<AtomicBool>,
    ids: &[i64],
    now: i64,
    emit: E,
) -> Result<ScanIssueRetryResult, String>
where
    E: Fn(ScanEmit) + Sync,
{
    let to_msg = |e: rusqlite::Error| e.to_string();
    let conn = db::open_db(db_path).map_err(to_msg)?;
    let rows = by_ids(&conn, ids).map_err(to_msg)?;
    let (folders, files): (Vec<&ScanIssue>, Vec<&ScanIssue>) = rows
        .iter()
        .partition(|r| r.kind == IssueKind::Folder.as_str());

    let mut roots = RootPaths::new();
    let mut retried = 0;
    for chunk in files.chunks(RETRY_CHUNK) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        retried += retry_files(&conn, db_path, chunk, &mut roots, now, &emit)?;
    }
    retried += retry_folders(&conn, db_path, cancel, &folders, &mut roots, now, &emit)?;

    let standing = by_ids(&conn, ids).map_err(to_msg)?.len();
    Ok(ScanIssueRetryResult {
        retried,
        cleared: rows.len().saturating_sub(standing) as u32,
        remaining: count(&conn).map_err(to_msg)?,
    })
}

/// The root's path when it exists and can be listed right now.
fn live_root(
    conn: &Connection,
    roots: &mut RootPaths,
    root_id: i64,
) -> Result<Option<PathBuf>, String> {
    if let Some(known) = roots.get(&root_id) {
        return Ok(known.clone());
    }
    let path = db::root_target(conn, root_id)
        .map_err(|e| e.to_string())?
        .map(|(_, path)| PathBuf::from(path))
        .filter(|path| root_reachable(path));
    roots.insert(root_id, path.clone());
    Ok(path)
}

/// Re-reads one chunk of `tags` and `stat` rows: upserts the tracks that can be read in one
/// transaction, then writes the rows in another. Returns how many rows it retried.
fn retry_files<E>(
    conn: &Connection,
    db_path: &Path,
    chunk: &[&ScanIssue],
    roots: &mut RootPaths,
    now: i64,
    emit: &E,
) -> Result<u32, String>
where
    E: Fn(ScanEmit) + Sync,
{
    let to_msg = |e: rusqlite::Error| e.to_string();
    let mut records = Vec::new();
    let mut drafts = Vec::new();
    let mut healed = Vec::new();
    let mut walked = BTreeSet::new();
    let mut retried = 0;

    for row in chunk {
        if live_root(conn, roots, row.root_id)?.is_none() {
            continue;
        }
        retried += 1;
        walked.insert(row.root_id);
        let key = normalize_path_key(&row.path);
        let path = Path::new(&row.path);
        // A row keeps its kind when the file still cannot be stat'd, so a tags row keeps its track.
        let kind = IssueKind::parse(&row.kind).unwrap_or(IssueKind::Stat);

        let (size, mtime) = match file_stats_checked(path) {
            Ok(stat) => stat,
            Err(err) => {
                match issue_draft(kind, row.root_id, path, key.clone(), &err) {
                    Some(draft) => drafts.push(draft),
                    None => healed.push(key),
                }
                continue;
            }
        };
        let (raw, failure) = read_tags_detailed(path);
        match failure {
            // Gone between the stat and the read.
            Some(TagFailure { reason: None, .. }) => {
                healed.push(key);
                continue;
            }
            Some(TagFailure {
                reason: Some(reason),
                detail,
            }) => drafts.push(IssueDraft {
                path: row.path.clone(),
                key,
                root_id: row.root_id,
                kind: IssueKind::Tags,
                reason,
                detail,
            }),
            None => healed.push(key),
        }
        records.push((
            normalize_track(&row.path, size, mtime, now, &raw),
            row.root_id,
        ));
    }

    let mut changed = Vec::with_capacity(records.len());
    let tx = conn.unchecked_transaction().map_err(to_msg)?;
    for (record, root_id) in &records {
        changed.push(db::upsert_track(&tx, record, Some(*root_id)).map_err(to_msg)?);
    }
    tx.commit().map_err(to_msg)?;

    let scopes: Vec<IssueScope> = walked
        .iter()
        .map(|&root_id| IssueScope {
            root_id,
            units: None,
        })
        .collect();
    let applied = apply_pass(conn, &drafts, &healed, &scopes, false, now).map_err(to_msg)?;
    log_pass(db_path, &applied.changed);
    if !changed.is_empty() {
        emit(ScanEmit::Changed(changed));
    }
    Ok(retried)
}

/// Rescans the failed folders, one narrowed pass per root with each folder as a recursive unit.
/// Returns how many rows it retried.
fn retry_folders<E>(
    conn: &Connection,
    db_path: &Path,
    cancel: &Arc<AtomicBool>,
    folders: &[&ScanIssue],
    roots: &mut RootPaths,
    now: i64,
    emit: &E,
) -> Result<u32, String>
where
    E: Fn(ScanEmit) + Sync,
{
    let mut by_root: BTreeMap<i64, Vec<ScanUnit>> = BTreeMap::new();
    for row in folders {
        if live_root(conn, roots, row.root_id)?.is_some() {
            by_root.entry(row.root_id).or_default().push(ScanUnit {
                dir: PathBuf::from(&row.path),
                recursive: true,
            });
        }
    }

    let mut retried = 0;
    for (id, units) in by_root {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let Some(Some(path)) = roots.get(&id).cloned() else {
            continue;
        };
        retried += units.len() as u32;
        let root = ScanRoot {
            id,
            path,
            units: Some(units),
        };
        run_scan(&[root], db_path, cancel, now, &HashMap::new(), emit)?;
    }
    Ok(retried)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::issues::Reason;
    use std::fs;
    use std::sync::atomic::AtomicU32;
    use std::sync::Mutex;

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

    // A music folder indexed once, with its database.
    struct Library {
        music: TempDir,
        _store: TempDir,
        db_path: PathBuf,
        root_id: i64,
    }

    impl Library {
        fn new() -> Self {
            let music = TempDir::new("retry_music");
            let store = TempDir::new("retry_db");
            let db_path = store.path.join("plisto.sqlite");
            let conn = db::open_db(&db_path).unwrap();
            let (root_id, _) =
                db::get_or_create_root(&conn, &music.path.to_string_lossy(), 1).unwrap();
            Self {
                music,
                _store: store,
                db_path,
                root_id,
            }
        }

        fn scan(&self, at: i64) {
            let cancel = Arc::new(AtomicBool::new(false));
            let root = ScanRoot {
                id: self.root_id,
                path: self.music.path.clone(),
                units: None,
            };
            run_scan(&[root], &self.db_path, &cancel, at, &HashMap::new(), |_| {}).unwrap();
        }

        fn conn(&self) -> Connection {
            db::open_db(&self.db_path).unwrap()
        }

        fn issues(&self) -> Vec<ScanIssue> {
            db::scan_issues::list(&self.conn(), 0, 100, None).unwrap()
        }

        fn ids(&self) -> Vec<i64> {
            self.issues().iter().map(|i| i.id).collect()
        }

        // Retries `ids` at `now`, returning the result and every changed track id.
        fn retry(&self, ids: &[i64], now: i64) -> (ScanIssueRetryResult, Vec<i64>) {
            let changed = Mutex::new(Vec::new());
            let cancel = Arc::new(AtomicBool::new(false));
            let result = retry_issues(&self.db_path, &cancel, ids, now, |e| {
                if let ScanEmit::Changed(ids) = e {
                    changed.lock().unwrap().extend(ids);
                }
            })
            .unwrap();
            (result, changed.into_inner().unwrap())
        }

        fn track_id(&self, file: &Path) -> Option<i64> {
            self.conn()
                .query_row(
                    "SELECT id FROM tracks WHERE source_path = ?1",
                    [normalize_path_key(&file.to_string_lossy())],
                    |r| r.get(0),
                )
                .ok()
        }
    }

    fn valid_audio() -> Vec<u8> {
        crate::covers::test_support::minimal_mp4()
    }

    #[test]
    fn a_fixed_file_clears_its_row_and_its_track_is_reported_changed() {
        let lib = Library::new();
        let file = lib.music.path.join("a.m4a");
        fs::write(&file, b"this is not audio").unwrap();
        lib.scan(1000);
        assert_eq!(lib.issues().len(), 1);

        fs::write(&file, valid_audio()).unwrap();
        let (result, changed) = lib.retry(&lib.ids(), 2000);

        assert_eq!(
            result,
            ScanIssueRetryResult {
                retried: 1,
                cleared: 1,
                remaining: 0
            }
        );
        assert!(lib.issues().is_empty());
        assert_eq!(changed, vec![lib.track_id(&file).unwrap()]);
    }

    #[test]
    fn a_still_broken_file_keeps_its_row_with_a_fresh_last_seen() {
        let lib = Library::new();
        fs::write(lib.music.path.join("a.m4a"), b"this is not audio").unwrap();
        lib.scan(1000);

        let (result, _) = lib.retry(&lib.ids(), 2000);

        assert_eq!(
            result,
            ScanIssueRetryResult {
                retried: 1,
                cleared: 0,
                remaining: 1
            }
        );
        let rows = lib.issues();
        assert_eq!(
            (rows[0].first_seen, rows[0].last_seen, rows[0].kind.as_str()),
            (1000, 2000, "tags")
        );
        assert!(rows[0].track_id.is_some(), "the row still names its track");
    }

    #[test]
    fn only_the_named_rows_are_retried() {
        let lib = Library::new();
        let a = lib.music.path.join("a.m4a");
        let b = lib.music.path.join("b.m4a");
        fs::write(&a, b"nope").unwrap();
        fs::write(&b, b"nope").unwrap();
        lib.scan(1000);
        fs::write(&a, valid_audio()).unwrap();
        fs::write(&b, valid_audio()).unwrap();
        let first = lib.issues()[0].id;

        let (result, _) = lib.retry(&[first, 9999], 2000);

        assert_eq!(
            result,
            ScanIssueRetryResult {
                retried: 1,
                cleared: 1,
                remaining: 1
            }
        );
    }

    #[test]
    fn a_vanished_file_clears_its_row() {
        let lib = Library::new();
        let file = lib.music.path.join("a.m4a");
        fs::write(&file, b"nope").unwrap();
        lib.scan(1000);
        fs::remove_file(&file).unwrap();

        let (result, changed) = lib.retry(&lib.ids(), 2000);

        assert_eq!(
            result,
            ScanIssueRetryResult {
                retried: 1,
                cleared: 1,
                remaining: 0
            }
        );
        assert!(changed.is_empty(), "nothing was written to the index");
    }

    #[test]
    fn a_stat_row_reads_the_file_as_a_new_track_once_it_stats() {
        let lib = Library::new();
        let file = lib.music.path.join("a.m4a");
        fs::write(&file, valid_audio()).unwrap();
        let drafts = [IssueDraft {
            path: file.to_string_lossy().into_owned(),
            key: normalize_path_key(&file.to_string_lossy()),
            root_id: lib.root_id,
            kind: IssueKind::Stat,
            reason: Reason::AccessDenied,
            detail: String::new(),
        }];
        let scope = IssueScope {
            root_id: lib.root_id,
            units: None,
        };
        apply_pass(&lib.conn(), &drafts, &[], &[scope], true, 1000).unwrap();
        assert!(lib.track_id(&file).is_none());

        let (result, changed) = lib.retry(&lib.ids(), 2000);

        assert_eq!((result.cleared, result.remaining), (1, 0));
        assert_eq!(changed, vec![lib.track_id(&file).unwrap()]);
    }

    #[test]
    fn a_folder_row_runs_a_narrowed_scan_and_clears_once_the_folder_reads() {
        let lib = Library::new();
        let sub = lib.music.path.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let inside = sub.join("a.m4a");
        fs::write(&inside, valid_audio()).unwrap();
        let outside = lib.music.path.join("b.m4a");
        fs::write(&outside, valid_audio()).unwrap();
        let drafts = [IssueDraft {
            path: sub.to_string_lossy().into_owned(),
            key: crate::scan::dir_key(&sub),
            root_id: lib.root_id,
            kind: IssueKind::Folder,
            reason: Reason::AccessDenied,
            detail: String::new(),
        }];
        let scope = IssueScope {
            root_id: lib.root_id,
            units: None,
        };
        apply_pass(&lib.conn(), &drafts, &[], &[scope], true, 1000).unwrap();

        let (result, changed) = lib.retry(&lib.ids(), 2000);

        assert_eq!(
            result,
            ScanIssueRetryResult {
                retried: 1,
                cleared: 1,
                remaining: 0
            }
        );
        assert_eq!(changed, vec![lib.track_id(&inside).unwrap()]);
        assert!(
            lib.track_id(&outside).is_none(),
            "the scan stays inside the folder"
        );
    }

    #[test]
    fn a_folder_row_for_a_deleted_folder_clears() {
        let lib = Library::new();
        let gone = lib.music.path.join("gone");
        let drafts = [IssueDraft {
            path: gone.to_string_lossy().into_owned(),
            key: crate::scan::dir_key(&gone),
            root_id: lib.root_id,
            kind: IssueKind::Folder,
            reason: Reason::DiskError,
            detail: String::new(),
        }];
        let scope = IssueScope {
            root_id: lib.root_id,
            units: None,
        };
        apply_pass(&lib.conn(), &drafts, &[], &[scope], true, 1000).unwrap();

        let (result, _) = lib.retry(&lib.ids(), 2000);

        assert_eq!((result.retried, result.cleared), (1, 1));
    }

    #[test]
    fn an_unreachable_root_keeps_its_rows_untouched() {
        let lib = Library::new();
        let file = lib.music.path.join("a.m4a");
        fs::write(&file, b"nope").unwrap();
        lib.scan(1000);
        fs::remove_dir_all(&lib.music.path).unwrap();

        let (result, _) = lib.retry(&lib.ids(), 2000);

        assert_eq!(
            result,
            ScanIssueRetryResult {
                retried: 0,
                cleared: 0,
                remaining: 1
            }
        );
        assert_eq!(lib.issues()[0].last_seen, 1000);
    }

    #[test]
    fn a_cancelled_retry_leaves_its_rows() {
        let lib = Library::new();
        fs::write(lib.music.path.join("a.m4a"), b"nope").unwrap();
        lib.scan(1000);
        let cancel = Arc::new(AtomicBool::new(true));

        let result = retry_issues(&lib.db_path, &cancel, &lib.ids(), 2000, |_| {}).unwrap();

        assert_eq!(
            result,
            ScanIssueRetryResult {
                retried: 0,
                cleared: 0,
                remaining: 1
            }
        );
    }
}
