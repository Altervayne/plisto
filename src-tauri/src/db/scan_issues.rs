/*
 * The unreadable-file record: one `scan_issues` row per path a scan could not read, keyed by the
 * canonical path. A `tags` row (indexed, tags unparseable) persists across passes because an
 * unchanged file is never re-read; it clears when the file reads cleanly, goes missing, or its track
 * or root is removed. A `stat` or `folder` row is a per-scope finding: a complete pass replaces the
 * rows inside the scope it walked, and a cancelled pass only adds. A root left out of the scopes
 * contributes nothing, so a pulled drive does not bury the list in "offline" failures.
 */

// -- Library Imports --
use std::collections::{BTreeMap, HashSet};

use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

// -- Type Imports --
use crate::dto::ScanIssue;
use crate::scan::issues::{IssueDraft, IssueKind, Reason};
use crate::scan::{under_dir, UnitKey};

/// Ids bound per statement when deleting by id.
const ID_CHUNK: usize = 500;

/// One walked root's sweep scope: its id and, when the pass was narrowed, the units it covered.
/// `None` is the whole root.
pub struct IssueScope<'a> {
    pub root_id: i64,
    pub units: Option<&'a [UnitKey]>,
}

/// A draft that is new or whose reason differs from the stored row's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftChange {
    pub path: String,
    pub key: String,
    pub kind: IssueKind,
    pub reason: Reason,
    pub detail: String,
    /// True when no row existed for the key; false when only the reason changed.
    pub is_new: bool,
}

/// The outcome of one pass: the drafts that were new or changed reason, and the rows standing after.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub changed: Vec<DraftChange>,
    pub total: u32,
}

/// The canonical keys of every `tags` row, so a worker can tell a file that failed before from one
/// that never did. Only `tags` rows heal by a clean re-read.
pub fn load_issue_keys(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    conn.prepare("SELECT path_key FROM scan_issues WHERE kind = 'tags'")?
        .query_map([], |r| r.get(0))?
        .collect()
}

/// Writes one pass's findings in a single transaction. `drafts` are upserted (a `tags` draft is linked
/// to its track by `source_path`), keeping each row's `first_seen`; drafts of a root not in `scopes`
/// are dropped. `healed` are keys whose issue is resolved this pass: a `tags` file that read cleanly,
/// or a retried file that read or vanished. On a `complete` pass, `stat` and
/// `folder` rows inside each scope that were not rediscovered are removed, and so are `tags` rows
/// whose track is flagged missing; a cancelled pass removes nothing but the healed rows.
pub fn apply_pass(
    conn: &Connection,
    drafts: &[IssueDraft],
    healed: &[String],
    scopes: &[IssueScope<'_>],
    complete: bool,
    now: i64,
) -> rusqlite::Result<Applied> {
    // A savepoint, not a transaction, so a caller already inside one can nest this write.
    conn.execute_batch("SAVEPOINT apply_pass")?;
    match write_pass(conn, drafts, healed, scopes, complete, now) {
        Ok(applied) => match conn.execute_batch("RELEASE apply_pass") {
            Ok(()) => Ok(applied),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK TO apply_pass; RELEASE apply_pass");
                Err(e)
            }
        },
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK TO apply_pass; RELEASE apply_pass");
            Err(e)
        }
    }
}

fn write_pass(
    tx: &Connection,
    drafts: &[IssueDraft],
    healed: &[String],
    scopes: &[IssueScope<'_>],
    complete: bool,
    now: i64,
) -> rusqlite::Result<Applied> {
    let walked: HashSet<i64> = scopes.iter().map(|s| s.root_id).collect();
    let drafts: Vec<&IssueDraft> = drafts
        .iter()
        .filter(|d| walked.contains(&d.root_id))
        .collect();

    let mut changed = Vec::new();
    {
        let mut find = tx.prepare("SELECT reason FROM scan_issues WHERE path_key = ?1")?;
        let mut upsert = tx.prepare(
            "INSERT INTO scan_issues
                (path_key, path, root_id, track_id, kind, reason, detail, first_seen, last_seen)
             VALUES (?1, ?2, ?3,
                     CASE WHEN ?4 = 'tags' THEN (SELECT id FROM tracks WHERE source_path = ?1) END,
                     ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(path_key) DO UPDATE SET
                path = excluded.path,
                root_id = excluded.root_id,
                track_id = excluded.track_id,
                kind = excluded.kind,
                reason = excluded.reason,
                detail = excluded.detail,
                last_seen = excluded.last_seen",
        )?;
        for d in &drafts {
            let before: Option<String> = find.query_row(params![d.key], |r| r.get(0)).optional()?;
            let is_new = before.is_none();
            if is_new || before.as_deref() != Some(d.reason.as_str()) {
                changed.push(DraftChange {
                    path: d.path.clone(),
                    key: d.key.clone(),
                    kind: d.kind,
                    reason: d.reason,
                    detail: d.detail.clone(),
                    is_new,
                });
            }
            upsert.execute(params![
                d.key,
                d.path,
                d.root_id,
                d.kind.as_str(),
                d.reason.as_str(),
                d.detail,
                now
            ])?;
        }
    }

    delete_keys(tx, healed)?;

    if complete {
        let found: HashSet<&str> = drafts.iter().map(|d| d.key.as_str()).collect();
        sweep_scopes(tx, scopes, &found)?;
        sweep_missing_tracks(tx, &found)?;
    }

    let total = count(tx)?;
    Ok(Applied { changed, total })
}

/// Removes the `stat` and `folder` rows of each scope that this pass did not find again.
fn sweep_scopes(
    conn: &Connection,
    scopes: &[IssueScope<'_>],
    found: &HashSet<&str>,
) -> rusqlite::Result<()> {
    let mut stale = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, path_key, kind FROM scan_issues
         WHERE root_id = ?1 AND kind IN ('stat', 'folder')",
    )?;
    for scope in scopes {
        let rows = stmt
            .query_map(params![scope.root_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, key, kind) in rows {
            if !found.contains(key.as_str()) && in_scope(scope.units, &kind, &key) {
                stale.push(id);
            }
        }
    }
    delete_ids(conn, &stale)?;
    Ok(())
}

/// Removes the `tags` rows of tracks flagged missing, except a file read again this pass.
fn sweep_missing_tracks(conn: &Connection, found: &HashSet<&str>) -> rusqlite::Result<()> {
    let rows = conn
        .prepare(
            "SELECT i.id, i.path_key FROM scan_issues i JOIN tracks t ON t.id = i.track_id
             WHERE i.kind = 'tags' AND t.missing_at IS NOT NULL",
        )?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let stale: Vec<i64> = rows
        .into_iter()
        .filter(|(_, key)| !found.contains(key.as_str()))
        .map(|(id, _)| id)
        .collect();
    delete_ids(conn, &stale)?;
    Ok(())
}

/// Whether a row of `kind` at `key` lies inside a scope's units. A `folder` row names the failed
/// directory itself, so a flat unit covers it only when it is the unit's own folder.
fn in_scope(units: Option<&[UnitKey]>, kind: &str, key: &str) -> bool {
    let Some(units) = units else {
        return true;
    };
    units.iter().any(|u| match (kind, u.recursive) {
        ("folder", true) => under_dir(key, &u.key),
        ("folder", false) => key == u.key,
        _ => u.covers(key),
    })
}

fn delete_keys(conn: &Connection, keys: &[String]) -> rusqlite::Result<()> {
    for chunk in keys.chunks(ID_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        conn.execute(
            &format!("DELETE FROM scan_issues WHERE path_key IN ({marks})"),
            params_from_iter(chunk),
        )?;
    }
    Ok(())
}

const ISSUE_COLUMNS: &str = "id, path, root_id, track_id, kind, reason, detail, first_seen, last_seen";

/// The rows matching `?1` (a reason, or NULL for all) with their folder split off the canonical key
/// (`?2` is the path separator): the key minus its trailing run of non-separator characters.
const WITH_FOLDER: &str = "(SELECT *, rtrim(path_key, replace(path_key, ?2, '')) AS folder
                           FROM scan_issues WHERE (?1 IS NULL OR reason = ?1))";

/// Siblings together: by folder, then file name, both from the case-folded key.
const FOLDER_THEN_NAME: &str = "ORDER BY folder, substr(path_key, length(folder) + 1), id";

fn issue_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ScanIssue> {
    Ok(ScanIssue {
        id: r.get(0)?,
        path: r.get(1)?,
        root_id: r.get(2)?,
        track_id: r.get(3)?,
        kind: r.get(4)?,
        reason: r.get(5)?,
        detail: r.get(6)?,
        first_seen: r.get(7)?,
        last_seen: r.get(8)?,
    })
}

/// One page of issues, ordered by folder then file name, optionally only those of `reason`.
pub fn list(
    conn: &Connection,
    offset: u32,
    limit: u32,
    reason: Option<Reason>,
) -> rusqlite::Result<Vec<ScanIssue>> {
    conn.prepare(&format!(
        "SELECT {ISSUE_COLUMNS} FROM {WITH_FOLDER} {FOLDER_THEN_NAME} LIMIT ?3 OFFSET ?4"
    ))?
    .query_map(
        params![
            reason.map(Reason::as_str),
            std::path::MAIN_SEPARATOR_STR,
            limit,
            offset
        ],
        issue_from_row,
    )?
    .collect()
}

/// The rows with these ids, in no particular order; an id with no row is left out.
pub fn by_ids(conn: &Connection, ids: &[i64]) -> rusqlite::Result<Vec<ScanIssue>> {
    let mut rows = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(ID_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut stmt = conn.prepare(&format!(
            "SELECT {ISSUE_COLUMNS} FROM scan_issues WHERE id IN ({marks})"
        ))?;
        let found = stmt
            .query_map(params_from_iter(chunk), issue_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.extend(found);
    }
    Ok(rows)
}

/// How many issues stand.
pub fn count(conn: &Connection) -> rusqlite::Result<u32> {
    conn.query_row("SELECT COUNT(*) FROM scan_issues", [], |r| r.get(0))
}

/// How many issues carry `reason`, or how many stand when it is None.
pub fn count_matching(conn: &Connection, reason: Option<Reason>) -> rusqlite::Result<u32> {
    conn.query_row(
        "SELECT COUNT(*) FROM scan_issues WHERE (?1 IS NULL OR reason = ?1)",
        params![reason.map(Reason::as_str)],
        |r| r.get(0),
    )
}

/// The row count per reason code over the whole table; a code with no rows is absent.
pub fn count_by_reason(conn: &Connection) -> rusqlite::Result<BTreeMap<String, u32>> {
    conn.prepare("SELECT reason, COUNT(*) FROM scan_issues GROUP BY reason")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect()
}

/// Which rows a bulk action targets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    Ids(Vec<i64>),
    Reason(Reason),
    All,
}

/// The ids a selection names. An id list is taken as given, so an id with no row is the caller's to
/// skip; a reason or all reads the table.
pub fn select_ids(conn: &Connection, selection: &Selection) -> rusqlite::Result<Vec<i64>> {
    match selection {
        Selection::Ids(ids) => Ok(ids.clone()),
        Selection::Reason(reason) => conn
            .prepare("SELECT id FROM scan_issues WHERE reason = ?1 ORDER BY id")?
            .query_map(params![reason.as_str()], |r| r.get(0))?
            .collect(),
        Selection::All => conn
            .prepare("SELECT id FROM scan_issues ORDER BY id")?
            .query_map([], |r| r.get(0))?
            .collect(),
    }
}

/// Deletes the rows with these ids and returns how many existed.
pub fn delete_ids(conn: &Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    let mut removed = 0;
    for chunk in ids.chunks(ID_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        removed += conn.execute(
            &format!("DELETE FROM scan_issues WHERE id IN ({marks})"),
            params_from_iter(chunk),
        )?;
    }
    Ok(removed)
}

/// The issues as plain text for copying, optionally only those of `reason`: a header line with the
/// count, then one tab-separated line per issue (reason, path, detail), ordered like the list.
pub fn export_text(conn: &Connection, reason: Option<Reason>) -> rusqlite::Result<String> {
    let rows: Vec<(String, String, String)> = conn
        .prepare(&format!(
            "SELECT reason, path, detail FROM {WITH_FOLDER} {FOLDER_THEN_NAME}"
        ))?
        .query_map(
            params![reason.map(Reason::as_str), std::path::MAIN_SEPARATOR_STR],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?
        .collect::<rusqlite::Result<_>>()?;
    let mut text = format!("Plisto scan issues: {}\n", rows.len());
    for (reason, path, detail) in rows {
        text.push_str(&format!("{reason}\t{path}\t{detail}\n"));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::scan::issues::sanitize_detail;

    fn root(conn: &Connection, key: &str) -> i64 {
        db::insert_root(conn, key, key, 1).unwrap()
    }

    fn track(conn: &Connection, root_id: i64, key: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, filename, ext, size_bytes, mtime, has_embedded_cover,
                                 scanned_at, root_id)
             VALUES (?1, 'a.mp3', 'mp3', 10, 20, 0, 30, ?2)",
            params![key, root_id],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    fn draft(root_id: i64, key: &str, kind: IssueKind, reason: Reason) -> IssueDraft {
        IssueDraft {
            path: key.to_string(),
            key: key.to_string(),
            root_id,
            kind,
            reason,
            detail: "boom".to_string(),
        }
    }

    // A key with the platform separator, the form a walk produces and `UnitKey::covers` expects.
    fn native(key: &str) -> String {
        key.replace('/', std::path::MAIN_SEPARATOR_STR)
    }

    fn whole(root_id: i64) -> IssueScope<'static> {
        IssueScope {
            root_id,
            units: None,
        }
    }

    fn keys(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT path_key FROM scan_issues ORDER BY path_key")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn a_pass_inside_a_rolled_back_transaction_leaves_no_rows() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let d = draft(r, "/m/a.mp3", IssueKind::Stat, Reason::AccessDenied);

        let tx = conn.unchecked_transaction().unwrap();
        apply_pass(&tx, &[d], &[], &[whole(r)], true, 1).unwrap();
        assert_eq!(keys(&tx).len(), 1);
        drop(tx);

        assert!(keys(&conn).is_empty());
    }

    #[test]
    fn a_failed_pass_rolls_back_its_rows_and_leaves_no_savepoint_open() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let first = draft(r, "/m/a.mp3", IssueKind::Stat, Reason::AccessDenied);
        let second = draft(r, "/m/b.mp3", IssueKind::Stat, Reason::AccessDenied);
        conn.execute_batch(
            "CREATE TEMP TRIGGER fail_second BEFORE INSERT ON scan_issues
             WHEN NEW.path_key = '/m/b.mp3'
             BEGIN SELECT RAISE(ABORT, 'boom'); END",
        )
        .unwrap();

        let out = apply_pass(&conn, &[first, second], &[], &[whole(r)], true, 1);

        assert!(out.is_err());
        assert!(keys(&conn).is_empty());
        conn.execute_batch("BEGIN; ROLLBACK").unwrap();
    }

    #[test]
    fn upsert_keeps_first_seen_and_refreshes_the_rest() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let t = track(&conn, r, "/m/a.mp3");
        let d = draft(r, "/m/a.mp3", IssueKind::Tags, Reason::CorruptOrUnsupported);

        let first =
            apply_pass(&conn, std::slice::from_ref(&d), &[], &[whole(r)], true, 100).unwrap();
        assert_eq!(first.total, 1);
        assert_eq!(first.changed.len(), 1);
        assert!(first.changed[0].is_new);

        let mut again = d;
        again.detail = "still boom".to_string();
        let second = apply_pass(&conn, &[again], &[], &[whole(r)], true, 200).unwrap();
        assert!(
            second.changed.is_empty(),
            "an unchanged reason is not a change"
        );

        let rows = list(&conn, 0, 10, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].first_seen,
                rows[0].last_seen,
                rows[0].detail.as_str()
            ),
            (100, 200, "still boom")
        );
        assert_eq!(rows[0].track_id, Some(t), "a tags row links to its track");
    }

    #[test]
    fn a_changed_reason_is_reported_but_not_as_new() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        track(&conn, r, "/m/a.mp3");
        let d = draft(r, "/m/a.mp3", IssueKind::Tags, Reason::Other);
        apply_pass(&conn, &[d], &[], &[whole(r)], true, 1).unwrap();

        let d = draft(r, "/m/a.mp3", IssueKind::Tags, Reason::AccessDenied);
        let out = apply_pass(&conn, &[d], &[], &[whole(r)], true, 2).unwrap();

        assert_eq!(out.changed.len(), 1);
        assert!(!out.changed[0].is_new);
        assert_eq!(out.changed[0].reason, Reason::AccessDenied);
        assert_eq!(
            list(&conn, 0, 10, None).unwrap()[0].reason,
            "access_denied"
        );
    }

    #[test]
    fn healed_keys_clear_tags_rows_even_on_a_cancelled_pass() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        track(&conn, r, "/m/a.mp3");
        let d = draft(r, "/m/a.mp3", IssueKind::Tags, Reason::Other);
        apply_pass(&conn, &[d], &[], &[whole(r)], true, 1).unwrap();
        assert_eq!(load_issue_keys(&conn).unwrap().len(), 1);

        let out = apply_pass(&conn, &[], &["/m/a.mp3".to_string()], &[whole(r)], false, 2).unwrap();

        assert_eq!(out.total, 0);
        assert!(load_issue_keys(&conn).unwrap().is_empty());
    }

    #[test]
    fn a_tags_row_persists_when_the_pass_does_not_touch_it() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        track(&conn, r, "/m/a.mp3");
        let d = draft(r, "/m/a.mp3", IssueKind::Tags, Reason::Other);
        apply_pass(&conn, &[d], &[], &[whole(r)], true, 1).unwrap();

        let out = apply_pass(&conn, &[], &[], &[whole(r)], true, 2).unwrap();

        assert_eq!(
            out.total, 1,
            "an unchanged failed file is skipped, so its row stands"
        );
    }

    #[test]
    fn a_complete_pass_replaces_stat_and_folder_rows_in_scope() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let first = [
            draft(r, "/m/a.mp3", IssueKind::Stat, Reason::AccessDenied),
            draft(r, "/m/locked", IssueKind::Folder, Reason::AccessDenied),
        ];
        apply_pass(&conn, &first, &[], &[whole(r)], true, 1).unwrap();

        let next = [draft(r, "/m/b.mp3", IssueKind::Stat, Reason::Other)];
        let out = apply_pass(&conn, &next, &[], &[whole(r)], true, 2).unwrap();

        assert_eq!(keys(&conn), vec!["/m/b.mp3"]);
        assert_eq!(out.total, 1);
    }

    #[test]
    fn a_cancelled_pass_adds_but_sweeps_nothing() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let first = [draft(r, "/m/a.mp3", IssueKind::Stat, Reason::Other)];
        apply_pass(&conn, &first, &[], &[whole(r)], true, 1).unwrap();

        let next = [draft(r, "/m/b.mp3", IssueKind::Stat, Reason::Other)];
        apply_pass(&conn, &next, &[], &[whole(r)], false, 2).unwrap();

        assert_eq!(keys(&conn), vec!["/m/a.mp3", "/m/b.mp3"]);
    }

    #[test]
    fn a_narrowed_pass_leaves_rows_outside_its_units_alone() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let first = [
            draft(r, &native("/m/in/a.mp3"), IssueKind::Stat, Reason::Other),
            draft(
                r,
                &native("/m/in/deep/b.mp3"),
                IssueKind::Stat,
                Reason::Other,
            ),
            draft(r, &native("/m/out/c.mp3"), IssueKind::Stat, Reason::Other),
            draft(r, &native("/m/in/bad"), IssueKind::Folder, Reason::Other),
            draft(r, &native("/m/out/bad"), IssueKind::Folder, Reason::Other),
        ];
        apply_pass(&conn, &first, &[], &[whole(r)], true, 1).unwrap();

        let units = [UnitKey {
            key: native("/m/in"),
            recursive: true,
        }];
        let scope = IssueScope {
            root_id: r,
            units: Some(&units),
        };
        apply_pass(&conn, &[], &[], &[scope], true, 2).unwrap();

        assert_eq!(
            keys(&conn),
            vec![native("/m/out/bad"), native("/m/out/c.mp3")]
        );
    }

    #[test]
    fn a_flat_unit_covers_its_own_files_and_folder_only() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let first = [
            draft(r, &native("/m/in/a.mp3"), IssueKind::Stat, Reason::Other),
            draft(
                r,
                &native("/m/in/deep/b.mp3"),
                IssueKind::Stat,
                Reason::Other,
            ),
            draft(r, &native("/m/in"), IssueKind::Folder, Reason::Other),
            draft(r, &native("/m/in/deep"), IssueKind::Folder, Reason::Other),
        ];
        apply_pass(&conn, &first, &[], &[whole(r)], true, 1).unwrap();

        let units = [UnitKey {
            key: native("/m/in"),
            recursive: false,
        }];
        let scope = IssueScope {
            root_id: r,
            units: Some(&units),
        };
        apply_pass(&conn, &[], &[], &[scope], true, 2).unwrap();

        assert_eq!(
            keys(&conn),
            vec![native("/m/in/deep"), native("/m/in/deep/b.mp3")]
        );
    }

    #[test]
    fn another_roots_rows_are_not_swept() {
        let conn = db::open_in_memory().unwrap();
        let a = root(&conn, "/a");
        let b = root(&conn, "/b");
        let first = [
            draft(a, "/a/x.mp3", IssueKind::Stat, Reason::Other),
            draft(b, "/b/y.mp3", IssueKind::Stat, Reason::Other),
        ];
        apply_pass(&conn, &first, &[], &[whole(a), whole(b)], true, 1).unwrap();

        apply_pass(&conn, &[], &[], &[whole(a)], true, 2).unwrap();

        assert_eq!(keys(&conn), vec!["/b/y.mp3"]);
    }

    #[test]
    fn a_root_outside_the_scopes_contributes_nothing() {
        let conn = db::open_in_memory().unwrap();
        let live = root(&conn, "/live");
        let gone = root(&conn, "/gone");
        let found = [
            draft(live, "/live/a.mp3", IssueKind::Stat, Reason::Other),
            draft(gone, "/gone/a.mp3", IssueKind::Stat, Reason::DiskError),
            draft(gone, "/gone/dir", IssueKind::Folder, Reason::DiskError),
        ];

        let out = apply_pass(&conn, &found, &[], &[whole(live)], true, 1).unwrap();

        assert_eq!(keys(&conn), vec!["/live/a.mp3"]);
        assert_eq!(out.changed.len(), 1);
    }

    #[test]
    fn a_track_flagged_missing_loses_its_tags_row() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let t = track(&conn, r, "/m/a.mp3");
        track(&conn, r, "/m/b.mp3");
        let found = [
            draft(r, "/m/a.mp3", IssueKind::Tags, Reason::Other),
            draft(r, "/m/b.mp3", IssueKind::Tags, Reason::Other),
        ];
        apply_pass(&conn, &found, &[], &[whole(r)], true, 1).unwrap();
        conn.execute("UPDATE tracks SET missing_at = 5 WHERE id = ?1", params![t])
            .unwrap();

        apply_pass(&conn, &[], &[], &[whole(r)], false, 2).unwrap();
        assert_eq!(keys(&conn).len(), 2, "a cancelled pass sweeps nothing");

        apply_pass(&conn, &[], &[], &[whole(r)], true, 3).unwrap();
        assert_eq!(keys(&conn), vec!["/m/b.mp3"]);
    }

    #[test]
    fn removing_a_root_cascades_its_rows() {
        let mut conn = db::open_in_memory().unwrap();
        let a = root(&conn, "/a");
        let b = root(&conn, "/b");
        track(&conn, a, "/a/x.mp3");
        let found = [
            draft(a, "/a/x.mp3", IssueKind::Tags, Reason::Other),
            draft(a, "/a/y.mp3", IssueKind::Stat, Reason::Other),
            draft(a, "/a/dir", IssueKind::Folder, Reason::Other),
            draft(b, "/b/z.mp3", IssueKind::Stat, Reason::Other),
        ];
        apply_pass(&conn, &found, &[], &[whole(a), whole(b)], true, 1).unwrap();

        db::remove_root(&mut conn, a).unwrap();

        assert_eq!(keys(&conn), vec!["/b/z.mp3"]);
    }

    #[test]
    fn purging_a_track_cascades_its_tags_row_only() {
        let mut conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let t = track(&conn, r, "/m/a.mp3");
        let found = [
            draft(r, "/m/a.mp3", IssueKind::Tags, Reason::Other),
            draft(r, "/m/b.mp3", IssueKind::Stat, Reason::Other),
        ];
        apply_pass(&conn, &found, &[], &[whole(r)], true, 1).unwrap();

        conn.execute("UPDATE tracks SET missing_at = 5 WHERE id = ?1", params![t])
            .unwrap();
        db::remove_missing_tracks(&mut conn, &[t]).unwrap();

        assert_eq!(keys(&conn), vec!["/m/b.mp3"]);
    }

    #[test]
    fn list_pages_and_delete_removes_by_id() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let found: Vec<IssueDraft> = (0..5)
            .map(|i| draft(r, &format!("/m/{i}.mp3"), IssueKind::Stat, Reason::Other))
            .collect();
        apply_pass(&conn, &found, &[], &[whole(r)], true, 1).unwrap();

        let page = list(&conn, 1, 2, None).unwrap();
        assert_eq!(
            page.iter().map(|i| i.path.as_str()).collect::<Vec<_>>(),
            vec!["/m/1.mp3", "/m/2.mp3"]
        );
        assert_eq!(count(&conn).unwrap(), 5);

        let ids: Vec<i64> = page.iter().map(|i| i.id).collect();
        assert_eq!(delete_ids(&conn, &ids).unwrap(), 2);
        assert_eq!(delete_ids(&conn, &ids).unwrap(), 0);
        assert_eq!(count(&conn).unwrap(), 3);
        assert_eq!(delete_ids(&conn, &[]).unwrap(), 0);
    }

    #[test]
    fn export_text_is_a_header_then_one_line_per_issue() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        assert_eq!(export_text(&conn, None).unwrap(), "Plisto scan issues: 0\n");

        let mut a = draft(r, "/m/a.mp3", IssueKind::Stat, Reason::AccessDenied);
        a.detail = sanitize_detail("os error 5\r\nsecond line");
        let b = draft(r, "/m/b.mp3", IssueKind::Tags, Reason::CorruptOrUnsupported);
        apply_pass(&conn, &[a, b], &[], &[whole(r)], true, 1).unwrap();

        assert_eq!(
            export_text(&conn, None).unwrap(),
            "Plisto scan issues: 2\n\
             access_denied\t/m/a.mp3\tos error 5  second line\n\
             corrupt_or_unsupported\t/m/b.mp3\tboom\n"
        );
        assert_eq!(
            export_text(&conn, Some(Reason::CorruptOrUnsupported)).unwrap(),
            "Plisto scan issues: 1\n\
             corrupt_or_unsupported\t/m/b.mp3\tboom\n"
        );
    }

    #[test]
    fn list_orders_by_folder_then_file_name_ignoring_case() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        // A file directly in "a" sorts before a file in its subfolder, whatever the names say.
        let paths = [
            "/m/a/sub/x.mp3",
            "/m/a/Z.mp3",
            "/m/b/a.mp3",
            "/m/a/b.mp3",
            "/m/a b/c.mp3",
        ];
        // The key is the folded form, as a scan writes it.
        let found: Vec<IssueDraft> = paths
            .iter()
            .map(|p| {
                let mut d = draft(r, &native(p), IssueKind::Stat, Reason::Other);
                d.key = d.key.to_lowercase();
                d
            })
            .collect();
        apply_pass(&conn, &found, &[], &[whole(r)], true, 1).unwrap();

        let order: Vec<String> = list(&conn, 0, 10, None)
            .unwrap()
            .into_iter()
            .map(|i| i.path)
            .collect();
        let want: Vec<String> = [
            "/m/a b/c.mp3",
            "/m/a/b.mp3",
            "/m/a/Z.mp3",
            "/m/a/sub/x.mp3",
            "/m/b/a.mp3",
        ]
        .iter()
        .map(|p| native(p))
        .collect();
        assert_eq!(order, want);
    }

    #[test]
    fn total_follows_the_filter_and_by_reason_spans_the_table() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let found = [
            draft(r, "/m/a.mp3", IssueKind::Stat, Reason::AccessDenied),
            draft(r, "/m/b.mp3", IssueKind::Stat, Reason::AccessDenied),
            draft(r, "/m/c.mp3", IssueKind::Stat, Reason::DiskError),
        ];
        apply_pass(&conn, &found, &[], &[whole(r)], true, 1).unwrap();

        assert_eq!(count(&conn).unwrap(), 3);
        assert_eq!(count_matching(&conn, None).unwrap(), 3);
        assert_eq!(
            count_matching(&conn, Some(Reason::AccessDenied)).unwrap(),
            2
        );
        let by = count_by_reason(&conn).unwrap();
        assert_eq!(by.get("access_denied"), Some(&2));
        assert_eq!(by.get("disk_error"), Some(&1));
        assert_eq!(by.get("other"), None);

        let page = list(&conn, 0, 10, Some(Reason::DiskError)).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].path, "/m/c.mp3");
    }

    #[test]
    fn selection_names_ids_a_reason_or_everything() {
        let conn = db::open_in_memory().unwrap();
        let r = root(&conn, "/m");
        let found = [
            draft(r, "/m/a.mp3", IssueKind::Stat, Reason::AccessDenied),
            draft(r, "/m/b.mp3", IssueKind::Stat, Reason::DiskError),
        ];
        apply_pass(&conn, &found, &[], &[whole(r)], true, 1).unwrap();
        let all = select_ids(&conn, &Selection::All).unwrap();
        assert_eq!(all.len(), 2);

        assert_eq!(
            select_ids(&conn, &Selection::Ids(vec![7, 8])).unwrap(),
            vec![7, 8]
        );
        let denied = select_ids(&conn, &Selection::Reason(Reason::AccessDenied)).unwrap();
        assert_eq!(denied.len(), 1);
        assert_eq!(by_ids(&conn, &denied).unwrap()[0].path, "/m/a.mp3");
        assert_eq!(by_ids(&conn, &[999]).unwrap().len(), 0);
    }
}
