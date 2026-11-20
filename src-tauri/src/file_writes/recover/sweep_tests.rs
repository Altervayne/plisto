/*
 * The sweep of committed writes' leftovers, and recovery as the scan and the launch run it: an
 * offline root is left whole, and a reachable one is settled before its files are read.
 */

use super::tests::{Fixture, NAME, ORIGINAL};
use super::*;
use crate::db::file_writes::{begin_batch, sweep_rows, SweepEntry, UndoDraft};
use rusqlite::params;

fn commit(f: &Fixture, sweep: Vec<SweepEntry>, kept: Option<&str>) -> i64 {
    let batch = begin_batch(&f.conn, "trim", None, 1).unwrap();
    let draft = UndoDraft {
        root_id: Some(f.root_id),
        rel_path: NAME.to_string(),
        backup_name: kept.map(str::to_string),
        sweep,
        ..UndoDraft::default()
    };
    f.conn
        .execute(
            "INSERT INTO file_write_journal (op_id, batch_id, kind, root_id, rel_path, rel_key,
                temp_name, backup_name, pre_size, pre_mtime, phase, undo_json, created_at)
             VALUES (?1, ?2, 'trim', ?3, ?4, ?4, 't', 'b', 0, 0, 'replaced', ?5, 1)",
            params![
                f.op,
                batch,
                f.root_id,
                NAME,
                serde_json::to_string(&draft).unwrap()
            ],
        )
        .unwrap();
    finish_file(&f.conn, &f.op, 2).unwrap().undo_id
}

#[test]
fn the_sweep_deletes_only_files_whose_size_matches() {
    let f = Fixture::new("sweep", "000000000000000c");
    fs::write(f.root.join("match"), b"12345").unwrap();
    fs::write(f.root.join("grown"), b"123456").unwrap();
    fs::write(f.root.join("kept"), b"123").unwrap();
    let entry = |name: &str, size| SweepEntry {
        name: name.to_string(),
        size,
    };
    let sweep = vec![
        entry("match", 5),
        entry("grown", 5),
        entry("gone", 1),
        entry("kept", 3),
    ];
    let id = commit(&f, sweep, Some("kept"));

    sweep_pending(&f.conn, |_| false).unwrap();
    assert!(f.root.join("match").exists());

    sweep_pending(&f.conn, |_| true).unwrap();
    assert!(!f.root.join("match").exists());
    assert!(f.root.join("grown").exists() && f.root.join("kept").exists());
    let left: Vec<String> = db::file_writes::undo_row(&f.conn, id)
        .unwrap()
        .unwrap()
        .sweep
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(left, ["grown", "kept"]);
}

#[test]
fn an_offline_root_keeps_its_rows_and_its_tracks() {
    let f = Fixture::new("offline", "000000000000000d");
    fs::write(f.source(), ORIGINAL).unwrap();
    assert_eq!(f.scan().0.inserted, 1);
    f.journal("trim", "journaled");
    let parked = f.dir.path.join("parked");
    fs::rename(&f.root, &parked).unwrap();

    let mut boot = WriteRecovery::default();
    recover_at_boot(&f.conn, 20, &mut boot, &mut reach_check()).unwrap();
    assert_eq!(boot.held_offline, 1);
    let (summary, found) = f.scan();
    assert_eq!(
        (summary.offline_roots, found.held_offline),
        (vec![f.root_id], 1)
    );
    assert_eq!(f.rows(), 1);
    let missing: i64 = f
        .conn
        .query_row(
            "SELECT COUNT(*) FROM tracks WHERE missing_at IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(missing, 0);

    // Back online, the scan settles the row before it walks.
    fs::rename(&parked, &f.root).unwrap();
    assert_eq!(f.scan().1, WriteRecovery::default());
    assert_eq!(f.rows(), 0);
}

#[test]
fn the_scan_restores_an_interrupted_write_before_it_reads_the_file() {
    let f = Fixture::new("scan", "000000000000000e");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "replaced");
    f.swap();

    let (summary, found) = f.scan();
    assert_eq!((found.restored, summary.inserted), (1, 1));
    let size: i64 = f
        .conn
        .query_row("SELECT size_bytes FROM tracks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(size, ORIGINAL.len() as i64);
    assert_eq!(f.rows(), 0);
}

#[test]
fn the_launch_run_settles_a_reachable_root_then_sweeps() {
    let f = Fixture::new("boot", "000000000000000f");
    fs::write(f.root.join("leftover"), b"12345").unwrap();
    let entry = SweepEntry {
        name: "leftover".to_string(),
        size: 5,
    };
    commit(&f, vec![entry], None);
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "replaced");
    f.swap();

    let mut report = WriteRecovery::default();
    recover_at_boot(&f.conn, 20, &mut report, &mut reach_check()).unwrap();
    assert_eq!((report.restored, report.held_offline), (1, 0));
    assert_eq!(f.read(&f.source()).as_deref(), Some(ORIGINAL));
    assert!(!f.root.join("leftover").exists());
    assert!(sweep_rows(&f.conn).unwrap().is_empty());
    assert_eq!(f.rows(), 0);
}

#[test]
fn a_root_whose_rows_cannot_be_settled_sits_the_scan_out_and_keeps_its_report() {
    let f = Fixture::new("stuck", "0000000000000010");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "replaced");
    f.swap();
    // A second row, settled after the first, whose drop the index refuses.
    let other = f.root.join("other.opus");
    fs::write(&other, ORIGINAL).unwrap();
    let (size, mtime) = file_stats_checked(&other).unwrap();
    f.conn
        .execute_batch(&format!(
            "INSERT INTO file_write_journal (op_id, batch_id, kind, root_id, rel_path, rel_key,
                temp_name, backup_name, pre_size, pre_mtime, phase, created_at)
             VALUES ('stuck', (SELECT MAX(id) FROM file_write_batches), 'trim', {}, 'other.opus',
                'other.opus', 't', 'b', {size}, {mtime}, 'journaled', 2);
             CREATE TRIGGER stuck BEFORE DELETE ON file_write_journal WHEN OLD.op_id = 'stuck'
             BEGIN SELECT RAISE(ABORT, 'stuck'); END;",
            f.root_id
        ))
        .unwrap();

    let (summary, found) = f.scan();
    assert_eq!(found.restored, 1);
    assert_eq!((summary.inserted, summary.offline_roots.len()), (0, 0));
    assert_eq!(f.rows(), 1);

    f.conn.execute_batch("DROP TRIGGER stuck").unwrap();
    assert_eq!(f.scan().0.inserted, 2);
    assert_eq!(f.rows(), 0);
}

#[test]
fn a_root_that_answers_after_the_deadline_counts_as_unreachable() {
    fn slow(_: &Path) -> bool {
        thread::sleep(Duration::from_secs(2));
        true
    }
    fn quick(_: &Path) -> bool {
        true
    }
    let started = std::time::Instant::now();
    assert!(!reachable_within(
        Path::new("x"),
        Duration::from_millis(20),
        slow
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(reachable_within(
        Path::new("x"),
        Duration::from_secs(5),
        quick
    ));
}
