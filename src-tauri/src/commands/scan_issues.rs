/*
 * The IPC command surface for reviewing files and folders a scan could not read: a filtered, paged
 * list, the standing count, a retry, the plain-text list for copying, and a dismiss. Retry takes the
 * app-level scan lock like a root removal, so it never runs beside a scan; the rest only touch the
 * issue table. A reason filter that is not one of the known codes is an error, never "all". Each
 * command is a thin wrapper over a plain function on a connection or the app state.
 */

// -- Library Imports --
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

// -- Local Imports --
use crate::db::scan_issues::{self, Selection};
use crate::dto::{LibraryDelta, ScanIssuePage, ScanIssueRetryProgress, ScanIssueRetryResult};
use crate::scan::issues::Reason;
use crate::scan::log::log_path;
use crate::scan::retry::retry_issues;
use crate::scan::ScanEmit;
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

/// The most rows one page returns.
const MAX_PAGE: u32 = 500;

/// One page of issues ordered by folder then file name, with the match count for `reason` and the row
/// count of every reason over the whole table. Read-only.
#[tauri::command]
pub fn scan_issues_list(
    offset: u32,
    limit: u32,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<ScanIssuePage, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    page(&conn, offset, limit, reason.as_deref())
}

/// How many issues stand across every root. Read-only.
#[tauri::command]
pub fn scan_issues_count(state: State<'_, AppState>) -> Result<u32, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    scan_issues::count(&conn).map_err(|e| e.to_string())
}

/// Retries the issues named by `ids`, else every issue of `reason`, else all of them: each file is
/// read again and each failed folder rescanned. Rejects while a user scan runs and preempts a
/// background pass. Changed tracks are announced on `library:delta` so open lists update, and rows
/// finished out of rows selected on `scan-issues:retry-progress`.
#[tauri::command]
pub async fn scan_issues_retry(
    ids: Option<Vec<i64>>,
    reason: Option<String>,
    app: AppHandle,
) -> Result<ScanIssueRetryResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        run_retry(
            &state,
            ids,
            reason.as_deref(),
            |e| announce(&app, e),
            |p| announce_progress(&app, p),
        )
    })
    .await
    .map_err(|_| "retry task failed to run".to_string())?
}

/// The issue list as plain text for copying, following the reason filter. Read-only.
#[tauri::command]
pub fn scan_issues_text(
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    text(&conn, reason.as_deref())
}

/// Deletes the issues named by `ids`, else every issue of `reason`, else all of them, without
/// retrying, and returns how many it deleted.
#[tauri::command]
pub fn scan_issues_clear(
    ids: Option<Vec<i64>>,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "index is unavailable".to_string())?;
    clear(&conn, ids, reason.as_deref())
}

/// Opens `scan.log` in the system's default app. Returns false, creating nothing, when no scan has
/// logged an issue yet.
#[tauri::command]
pub fn scan_issues_open_log(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    use tauri_plugin_opener::OpenerExt;
    let Some(dir) = state.db_path.parent() else {
        return Ok(false);
    };
    let path = log_path(dir);
    if !path.is_file() {
        return Ok(false);
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Tells open track lists which tracks a retry changed.
fn announce(app: &AppHandle, emit: ScanEmit) {
    if let ScanEmit::Changed(ids) = emit {
        let _ = app.emit("library:delta", &LibraryDelta::Ids { ids });
    }
}

/// Tells the issues sheet how far a retry has got.
fn announce_progress(app: &AppHandle, progress: ScanIssueRetryProgress) {
    let _ = app.emit("scan-issues:retry-progress", progress);
}

/// The reason filter as a code, None for no filter, an error for anything else.
fn parse_reason(reason: Option<&str>) -> Result<Option<Reason>, String> {
    reason
        .map(|name| Reason::parse(name).ok_or_else(|| format!("unknown reason: {name}")))
        .transpose()
}

/// The rows a bulk action targets: the ids when given, else the reason, else every row. The reason is
/// validated even when the ids win.
fn selection(ids: Option<Vec<i64>>, reason: Option<&str>) -> Result<Selection, String> {
    let reason = parse_reason(reason)?;
    Ok(match (ids, reason) {
        (Some(ids), _) => Selection::Ids(ids),
        (None, Some(reason)) => Selection::Reason(reason),
        (None, None) => Selection::All,
    })
}

fn page(
    conn: &Connection,
    offset: u32,
    limit: u32,
    reason: Option<&str>,
) -> Result<ScanIssuePage, String> {
    let reason = parse_reason(reason)?;
    let to_msg = |e: rusqlite::Error| e.to_string();
    Ok(ScanIssuePage {
        total: scan_issues::count_matching(conn, reason).map_err(to_msg)?,
        rows: scan_issues::list(conn, offset, limit.min(MAX_PAGE), reason).map_err(to_msg)?,
        by_reason: scan_issues::count_by_reason(conn).map_err(to_msg)?,
    })
}

fn text(conn: &Connection, reason: Option<&str>) -> Result<String, String> {
    scan_issues::export_text(conn, parse_reason(reason)?).map_err(|e| e.to_string())
}

fn clear(conn: &Connection, ids: Option<Vec<i64>>, reason: Option<&str>) -> Result<u32, String> {
    let to_msg = |e: rusqlite::Error| e.to_string();
    let picked = scan_issues::select_ids(conn, &selection(ids, reason)?).map_err(to_msg)?;
    Ok(scan_issues::delete_ids(conn, &picked).map_err(to_msg)? as u32)
}

/// Takes the scan lock, resolves the selection, and retries it. A running user scan fails the lock
/// with the usual busy error before anything is read or written.
fn run_retry<E, P>(
    state: &AppState,
    ids: Option<Vec<i64>>,
    reason: Option<&str>,
    emit: E,
    progress: P,
) -> Result<ScanIssueRetryResult, String>
where
    E: Fn(ScanEmit) + Sync,
    P: Fn(ScanIssueRetryProgress),
{
    let selection = selection(ids, reason)?;
    let _lock = acquire_scan_lock(state, Holder::User)?;
    state
        .cancel
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let picked = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "index is unavailable".to_string())?;
        scan_issues::select_ids(&conn, &selection).map_err(|e| e.to_string())?
    };
    retry_issues(
        &state.db_path,
        &state.cancel,
        &picked,
        super::now_unix(),
        emit,
        progress,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::scan::issues::{IssueDraft, IssueKind};
    use crate::scan::{run_scan, ScanRoot};
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;

    fn draft(root_id: i64, key: &str, reason: Reason) -> IssueDraft {
        IssueDraft {
            path: key.to_string(),
            key: key.to_string(),
            root_id,
            kind: IssueKind::Stat,
            reason,
            detail: "boom".to_string(),
        }
    }

    fn seed(conn: &Connection, found: &[IssueDraft], root_id: i64) {
        let scope = scan_issues::IssueScope {
            root_id,
            units: None,
        };
        scan_issues::apply_pass(conn, found, &[], &[scope], true, 1).unwrap();
    }

    fn memory_with_root() -> (Connection, i64) {
        let conn = db::open_in_memory().unwrap();
        let root = db::insert_root(&conn, "/m", "/m", 1).unwrap();
        (conn, root)
    }

    #[test]
    fn a_page_carries_the_filtered_total_and_the_whole_tables_reason_counts() {
        let (conn, r) = memory_with_root();
        seed(
            &conn,
            &[
                draft(r, "/m/a.mp3", Reason::AccessDenied),
                draft(r, "/m/b.mp3", Reason::AccessDenied),
                draft(r, "/m/c.mp3", Reason::DiskError),
            ],
            r,
        );

        let all = page(&conn, 0, 2, None).unwrap();
        assert_eq!((all.total, all.rows.len()), (3, 2));
        let rest = page(&conn, 2, 2, None).unwrap();
        assert_eq!((rest.total, rest.rows.len()), (3, 1));

        let denied = page(&conn, 0, 10, Some("access_denied")).unwrap();
        assert_eq!((denied.total, denied.rows.len()), (2, 2));
        assert_eq!(denied.by_reason.get("access_denied"), Some(&2));
        assert_eq!(denied.by_reason.get("disk_error"), Some(&1));
    }

    #[test]
    fn a_page_never_exceeds_the_limit_cap() {
        let (conn, r) = memory_with_root();
        let found: Vec<IssueDraft> = (0..501)
            .map(|i| draft(r, &format!("/m/{i:04}.mp3"), Reason::Other))
            .collect();
        seed(&conn, &found, r);

        let page = page(&conn, 0, u32::MAX, None).unwrap();

        assert_eq!((page.total, page.rows.len()), (501, 500));
    }

    #[test]
    fn an_unknown_reason_is_an_error_everywhere_and_changes_nothing() {
        let (conn, r) = memory_with_root();
        seed(&conn, &[draft(r, "/m/a.mp3", Reason::Other)], r);

        assert!(page(&conn, 0, 10, Some("nope")).is_err());
        assert!(text(&conn, Some("nope")).is_err());
        assert!(clear(&conn, None, Some("nope")).is_err());
        assert!(
            clear(&conn, Some(vec![1]), Some("nope")).is_err(),
            "ids do not excuse a bad reason"
        );
        assert_eq!(scan_issues::count(&conn).unwrap(), 1);
    }

    #[test]
    fn text_follows_the_filter() {
        let (conn, r) = memory_with_root();
        seed(
            &conn,
            &[
                draft(r, "/m/a.mp3", Reason::AccessDenied),
                draft(r, "/m/b.mp3", Reason::DiskError),
            ],
            r,
        );

        assert_eq!(
            text(&conn, Some("disk_error")).unwrap(),
            "Plisto scan issues: 1\ndisk_error\t/m/b.mp3\tboom\n"
        );
        assert!(text(&conn, None)
            .unwrap()
            .starts_with("Plisto scan issues: 2\n"));
    }

    #[test]
    fn dismiss_by_ids_by_reason_and_all_returns_how_many_went() {
        let (conn, r) = memory_with_root();
        let found: Vec<IssueDraft> = [
            ("/m/a.mp3", Reason::AccessDenied),
            ("/m/b.mp3", Reason::AccessDenied),
            ("/m/c.mp3", Reason::DiskError),
            ("/m/d.mp3", Reason::Other),
        ]
        .iter()
        .map(|(k, reason)| draft(r, k, *reason))
        .collect();
        seed(&conn, &found, r);
        let ids: Vec<i64> = page(&conn, 0, 10, None)
            .unwrap()
            .rows
            .iter()
            .map(|i| i.id)
            .collect();

        assert_eq!(clear(&conn, Some(vec![ids[3], 9999]), None).unwrap(), 1);
        assert_eq!(clear(&conn, None, Some("access_denied")).unwrap(), 2);
        assert_eq!(clear(&conn, None, None).unwrap(), 1);
        assert_eq!(scan_issues::count(&conn).unwrap(), 0);
    }

    // A temp library with two unreadable files, indexed once at time 1000, and the state to retry it.
    // Fields drop in order, so the state's database closes before the folder is removed.
    struct Setup {
        state: AppState,
        files: [PathBuf; 2],
        _dir: Folder,
    }

    // The temp folder, removed on drop.
    struct Folder(PathBuf);

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl Setup {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "plisto_cmd_issues_{}_{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let music = dir.join("music");
            fs::create_dir_all(&music).unwrap();
            let files = [music.join("a.m4a"), music.join("b.m4a")];
            for file in &files {
                fs::write(file, b"this is not audio").unwrap();
            }
            let db_path = dir.join("plisto.sqlite");
            let conn = db::open_db(&db_path).unwrap();
            let (root_id, _) = db::get_or_create_root(&conn, &music.to_string_lossy(), 1).unwrap();
            let root = ScanRoot {
                id: root_id,
                path: music,
                units: None,
            };
            let cancel = Arc::new(AtomicBool::new(false));
            run_scan(&[root], &db_path, &cancel, 1000, &HashMap::new(), |_| {}).unwrap();

            let mut state = AppState::for_test(conn, PathBuf::new());
            state.db_path = db_path;
            Self {
                state,
                files,
                _dir: Folder(dir),
            }
        }

        fn fix_all(&self) {
            for file in &self.files {
                fs::write(file, crate::covers::test_support::minimal_mp4()).unwrap();
            }
        }

        fn rows(&self) -> Vec<crate::dto::ScanIssue> {
            let conn = self.state.db.lock().unwrap();
            scan_issues::list(&conn, 0, 100, None).unwrap()
        }
    }

    fn quiet(_e: ScanEmit) {}

    fn no_progress(_p: ScanIssueRetryProgress) {}

    #[test]
    fn retry_by_ids_by_reason_and_all() {
        let setup = Setup::new();
        let ids: Vec<i64> = setup.rows().iter().map(|i| i.id).collect();
        assert_eq!(ids.len(), 2);
        setup.fix_all();

        let one = run_retry(&setup.state, Some(vec![ids[0]]), None, quiet, no_progress).unwrap();
        assert_eq!((one.retried, one.cleared, one.remaining), (1, 1, 1));

        // The reason filter does not match the remaining row, so nothing is retried.
        let none = run_retry(&setup.state, None, Some("disk_error"), quiet, no_progress).unwrap();
        assert_eq!((none.retried, none.cleared, none.remaining), (0, 0, 1));

        let by_reason =
            run_retry(&setup.state, None, Some("corrupt_or_unsupported"), quiet, no_progress)
                .unwrap();
        assert_eq!(
            (by_reason.retried, by_reason.cleared, by_reason.remaining),
            (1, 1, 0)
        );
    }

    #[test]
    fn retry_with_no_selection_takes_every_row() {
        let setup = Setup::new();
        setup.fix_all();

        let all = run_retry(&setup.state, None, None, quiet, no_progress).unwrap();

        assert_eq!((all.retried, all.cleared, all.remaining), (2, 2, 0));
    }

    #[test]
    fn retry_while_a_user_scan_runs_errors_and_changes_nothing() {
        let setup = Setup::new();
        setup.fix_all();
        let held = acquire_scan_lock(&setup.state, Holder::User).unwrap();

        let blocked = run_retry(&setup.state, None, None, quiet, no_progress);

        assert_eq!(blocked.err().as_deref(), Some("a scan is already running"));
        let rows = setup.rows();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.last_seen == 1000));
        drop(held);
    }

    #[test]
    fn retry_with_an_unknown_reason_is_an_error_before_the_lock() {
        let setup = Setup::new();

        let result = run_retry(&setup.state, None, Some("nope"), quiet, no_progress);

        assert!(result.is_err());
        assert!(
            acquire_scan_lock(&setup.state, Holder::User).is_ok(),
            "the lock was never taken"
        );
    }
}
