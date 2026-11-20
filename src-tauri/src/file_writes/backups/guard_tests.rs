use super::tests::{never, online, plant, rows, trimmed, LATER};
use super::*;
use crate::db::file_writes::{begin_batch, insert_journal, JournalRow};
use crate::file_writes::trim::tests::NOW;
use std::fs::OpenOptions;
use std::os::windows::fs::OpenOptionsExt;

const FILE_SHARE_READ: u32 = 1;

// Holds the file open without share-delete, so deleting it fails until the handle drops.
fn held(path: &Path) -> fs::File {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .unwrap()
}

// A journaled undo of the backup's trim, as one held for an offline root leaves behind.
fn target(conn: &Connection, root_id: i64, undo_id: i64) {
    let batch = begin_batch(conn, "trim", None, NOW).unwrap();
    insert_journal(
        conn,
        &JournalRow {
            op_id: "op-undo".to_string(),
            batch_id: batch,
            kind: "trim_undo".to_string(),
            root_id,
            rel_path: "song.opus".to_string(),
            rel_key: String::new(),
            temp_name: ".plisto-tmp-undo".to_string(),
            backup_name: ".plisto-tmp-bak-undo".to_string(),
            pre_size: 0,
            pre_mtime: 0,
            phase: String::new(),
            undo_json: None,
            target_undo_id: Some(undo_id),
            created_at: NOW,
        },
    )
    .unwrap();
}

#[test]
fn a_backup_that_cannot_be_deleted_keeps_its_row() {
    let (f, id, backup) = trimmed("bk_locked");
    let hold = held(&backup);

    assert_eq!(
        discard(&f.conn, id, online),
        Err("unavailable: the backup cannot be deleted".to_string())
    );
    assert_eq!(
        discard_all(&f.conn, online).unwrap(),
        KeptDiscardAllOutcome {
            failed: 1,
            ..Default::default()
        }
    );
    assert_eq!(expire(&f.conn, LATER, online, never).unwrap(), 0);

    assert!(backup.exists());
    assert_eq!(rows(&f), 1);
    drop(hold);
    assert_eq!(discard(&f.conn, id, online), Ok(false));
    assert!(!backup.exists());
    assert_eq!(rows(&f), 0);
}

#[test]
fn a_backup_an_unfinished_write_targets_is_left_alone() {
    let (f, id, backup) = trimmed("bk_targeted");
    target(&f.conn, f.root_id, id);

    assert_eq!(expire(&f.conn, LATER, online, never).unwrap(), 0);
    assert_eq!(
        discard(&f.conn, id, online),
        Err("unfinished writes".to_string())
    );
    assert_eq!(
        discard_all(&f.conn, online).unwrap(),
        KeptDiscardAllOutcome {
            failed: 1,
            ..Default::default()
        }
    );

    assert!(backup.exists());
    assert_eq!(rows(&f), 1);
    f.conn
        .execute("DELETE FROM file_write_journal", [])
        .unwrap();
    assert_eq!(discard(&f.conn, id, online), Ok(false));
    assert!(!backup.exists());
}

#[test]
fn the_hourly_turn_stops_once_the_background_cancel_flag_is_raised() {
    let (f, _, _) = trimmed("bk_turn_cancel");
    plant(&f, &f.root, ".plisto-tmp-bak-two", 3, Some(3));
    let mut state = AppState::for_test(db::open_db(&f.db_path).unwrap(), f.dir.path.join("c"));
    state.db_path = f.db_path.clone();
    let raise_on_first = |_: &Path| {
        state.bg_cancel.store(true, Ordering::SeqCst);
        true
    };

    assert!(hourly_turn(&state, LATER, raise_on_first));

    assert_eq!(rows(&f), 1, "the second row is left for the next turn");
}
