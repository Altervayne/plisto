/*
 * Recovery for roots that are about to change place. A write that a crash left half done can only be
 * settled where its files are, so a relocate recovers at the place the root is moving to, which is
 * the one it can reach, and only then checks whether anything is left.
 */

// -- Library Imports --
use std::path::Path;

use rusqlite::Connection;

// -- Local Imports --
use super::recover::{held_offline, recover_root};
use crate::db::file_writes::has_journal_under;
use crate::dto::WriteRecovery;

/// Recovers every journal row of `roots` with `place` as their folder, into `report`; when `place`
/// is not `reachable` the rows are counted as held offline instead. True when no root has a row
/// left, so the move may go ahead.
pub fn settle_before_move(
    conn: &Connection,
    roots: &[i64],
    place: &Path,
    reachable: bool,
    now: i64,
    report: &mut WriteRecovery,
) -> rusqlite::Result<bool> {
    for &root_id in roots {
        if reachable {
            recover_root(conn, root_id, place, now, report)?;
        } else {
            held_offline(conn, root_id, report)?;
        }
    }
    for &root_id in roots {
        if has_journal_under(conn, root_id, "")? {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::db::file_writes::{begin_batch, insert_journal, journal_rows, JournalRow};
    use crate::scan::file_stats_checked;
    use std::fs;
    use std::path::PathBuf;

    // A folder that removes itself.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "plisto_settle_{tag}_{}_{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // A row for `rel` in root `root_id` that expects the file to be as it was when journaled.
    fn journal_for(conn: &Connection, root_id: i64, rel: &str, pre: (i64, i64)) -> String {
        let batch = begin_batch(conn, "trim", None, 100).unwrap();
        let op = format!("op-{rel}");
        insert_journal(
            conn,
            &JournalRow {
                op_id: op.clone(),
                batch_id: batch,
                kind: "trim".to_string(),
                root_id,
                rel_path: rel.to_string(),
                rel_key: String::new(),
                temp_name: format!(".plisto-tmp-{op}-{rel}"),
                backup_name: format!(".plisto-tmp-bak-{op}-{rel}"),
                pre_size: pre.0,
                pre_mtime: pre.1,
                phase: "journaled".to_string(),
                undo_json: None,
                target_undo_id: None,
                created_at: 100,
            },
        )
        .unwrap();
        op
    }

    #[test]
    fn a_row_is_recovered_at_the_new_place_and_nothing_is_left() {
        let conn = db::open_in_memory().unwrap();
        let moved = TempDir::new("moved");
        let file = moved.0.join("a.opus");
        fs::write(&file, b"audio").unwrap();
        journal_for(&conn, 1, "a.opus", file_stats_checked(&file).unwrap());

        let mut report = WriteRecovery::default();
        let clear = settle_before_move(&conn, &[1], &moved.0, true, 200, &mut report).unwrap();
        assert!(clear);
        assert!(journal_rows(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn a_row_that_cannot_be_settled_stays_and_blocks_the_move() {
        let conn = db::open_in_memory().unwrap();
        let moved = TempDir::new("held");
        let file = moved.0.join("a.opus");
        fs::write(&file, b"audio").unwrap();
        journal_for(&conn, 1, "a.opus", (999, 999));

        let mut report = WriteRecovery::default();
        let clear = settle_before_move(&conn, &[1], &moved.0, true, 200, &mut report).unwrap();
        assert!(!clear);
        assert_eq!(journal_rows(&conn, 1).unwrap().len(), 1);
        assert_eq!(report.needs_attention.len(), 1);
        assert_eq!(fs::read(&file).unwrap(), b"audio");
    }

    #[test]
    fn an_unreachable_place_holds_the_rows_offline_and_touches_no_file() {
        let conn = db::open_in_memory().unwrap();
        let moved = TempDir::new("offline");
        let file = moved.0.join("a.opus");
        fs::write(&file, b"audio").unwrap();
        journal_for(&conn, 1, "a.opus", (999, 999));

        let mut report = WriteRecovery::default();
        let clear = settle_before_move(&conn, &[1], &moved.0, false, 200, &mut report).unwrap();
        assert!(!clear);
        assert!(report.needs_attention.is_empty());
        assert_eq!(report.held_offline, 1);
        assert_eq!(journal_rows(&conn, 1).unwrap().len(), 1);
        assert_eq!(fs::read(&file).unwrap(), b"audio");
    }

    #[test]
    fn a_root_with_no_rows_is_clear() {
        let conn = db::open_in_memory().unwrap();
        let mut report = WriteRecovery::default();
        let nowhere = Path::new("Z:\\no\\such\\place");
        assert!(settle_before_move(&conn, &[1, 2], nowhere, true, 200, &mut report).unwrap());
        assert!(report.is_empty());
    }
}
