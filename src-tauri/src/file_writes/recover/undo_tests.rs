/*
 * Recovery of an interrupted trim undo: it is finished only when the source is the kept backup put
 * back, since finishing it sweeps that backup, and rolled back without losing that backup.
 */

use super::tests::{attention, Fixture, NAME, ORIGINAL, WRITTEN};
use super::*;
use crate::db::file_writes::{begin_batch, insert_journal, set_phase, SweepEntry, UndoMark};
use crate::file_writes::names::{backup_name, temp_name};
use rusqlite::params;

const TRIMMED: &[u8] = b"trimmed";
const TRIM_OP: &str = "00000000000000f0";

/// A committed trim of `song.opus` that kept its original hidden, and an undo of it journaled under
/// `f.op` in `phase` with its temp holding a copy of the kept backup, mtime included. The backup is
/// dated well in the past. Returns the kept backup's path and the trim's undo row id.
fn undo_of_a_trim(f: &Fixture, phase: &str) -> (PathBuf, i64) {
    let kept = f.root.join(backup_name(TRIM_OP, NAME));
    fs::write(&kept, ORIGINAL).unwrap();
    let past = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
    fs::File::options()
        .write(true)
        .open(&kept)
        .unwrap()
        .set_modified(past)
        .unwrap();
    set_hidden(&kept).unwrap();
    fs::write(f.source(), TRIMMED).unwrap();
    let batch = begin_batch(&f.conn, "trim", None, 1).unwrap();
    f.conn
        .execute(
            "INSERT INTO file_write_undo (batch_id, kind, root_id, root_path, rel_path, title,
                backup_name, backup_size, post_size, post_mtime)
             VALUES (?1, 'trim', ?2, '', ?3, '', ?4, ?5, 0, 0)",
            params![
                batch,
                f.root_id,
                NAME,
                backup_name(TRIM_OP, NAME),
                ORIGINAL.len() as i64
            ],
        )
        .unwrap();
    let target = f.conn.last_insert_rowid();

    let (pre_size, pre_mtime) = file_stats_checked(&f.source()).unwrap();
    let undo_batch = begin_batch(&f.conn, "trim", None, 2).unwrap();
    insert_journal(
        &f.conn,
        &JournalRow {
            op_id: f.op.clone(),
            batch_id: undo_batch,
            kind: "trim_undo".to_string(),
            root_id: f.root_id,
            rel_path: NAME.to_string(),
            rel_key: String::new(),
            temp_name: temp_name(&f.op, NAME),
            backup_name: backup_name(&f.op, NAME),
            pre_size,
            pre_mtime,
            phase: String::new(),
            undo_json: None,
            target_undo_id: Some(target),
            created_at: 2,
        },
    )
    .unwrap();
    fs::copy(&kept, f.temp()).unwrap();
    clear_hidden(&f.temp()).unwrap();
    let mark = UndoMark {
        sweep: vec![
            SweepEntry {
                name: backup_name(TRIM_OP, NAME),
                size: ORIGINAL.len() as i64,
            },
            SweepEntry {
                name: backup_name(&f.op, NAME),
                size: TRIMMED.len() as i64,
            },
        ],
    };
    let json = serde_json::to_string(&mark).unwrap();
    set_phase(&f.conn, &f.op, phase, Some(&json)).unwrap();
    (kept, target)
}

fn undone(f: &Fixture, target: i64) -> bool {
    undo_row(&f.conn, target)
        .unwrap()
        .unwrap()
        .undone_at
        .is_some()
}

#[test]
fn an_undo_stopped_before_its_swap_keeps_the_backup_when_the_source_was_edited() {
    // The user deletes the temp and retags the trimmed file, once to the backup's exact size.
    for retagged in [&b"trimmed, retagged"[..], b"retagged bytes"] {
        let f = Fixture::new("undo_edited", "00000000000000f1");
        let (kept, target) = undo_of_a_trim(&f, "temp_synced");
        fs::remove_file(f.temp()).unwrap();
        fs::write(f.source(), retagged).unwrap();

        assert_eq!(f.recover().needs_attention, attention(&f));
        sweep_pending(&f.conn, |_| true).unwrap();
        assert_eq!(f.read(&kept).as_deref(), Some(ORIGINAL));
        assert!(!undone(&f, target));
        assert_eq!(f.rows(), 1);
    }
}

#[test]
fn an_undo_whose_swap_ran_is_finished_and_its_backup_swept() {
    let f = Fixture::new("undo_swapped", "00000000000000f2");
    let (kept, target) = undo_of_a_trim(&f, "temp_synced");
    let done = replace(&f.source(), &f.temp(), &f.backup()).unwrap();
    assert_eq!(done, ReplaceOutcome::Replaced);
    set_phase(&f.conn, &f.op, "replaced", None).unwrap();
    fs::remove_file(f.backup()).unwrap();

    assert_eq!(f.recover().finished, 1);
    assert!(undone(&f, target));
    sweep_pending(&f.conn, |_| true).unwrap();
    assert!(!kept.exists());
    assert_eq!(f.read(&f.source()).as_deref(), Some(ORIGINAL));
    assert_eq!(f.rows(), 0);
}

#[test]
fn an_undo_swapped_back_restores_its_kept_backup() {
    // A trim undo moves the kept backup over the source; rolled back, the backup is whole again. The
    // writer never gives an undo a kept backup as its temp, so this shape is defensive: it covers the
    // guard on a swap back.
    let f = Fixture::new("undo", "000000000000000a");
    fs::write(f.source(), WRITTEN).unwrap();
    fs::write(f.temp(), ORIGINAL).unwrap();
    f.journal("trim_undo", "replaced");
    f.keep(&temp_name(&f.op, NAME));
    let done = replace(&f.source(), &f.temp(), &f.backup()).unwrap();
    assert_eq!(done, ReplaceOutcome::Replaced);

    assert_eq!(f.recover().restored, 1);
    assert_eq!(f.read(&f.source()).as_deref(), Some(WRITTEN));
    assert_eq!(f.read(&f.temp()).as_deref(), Some(ORIGINAL));
    assert!(super::super::attrs::is_hidden(&f.temp()).unwrap());
    assert!(!f.backup().exists());
    assert_eq!(f.rows(), 0);
}
