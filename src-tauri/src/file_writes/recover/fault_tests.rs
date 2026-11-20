/*
 * A reference writer stopped after each durable step, then recovered and swept: a write stopped
 * before its undo row is recorded comes back as the original, one stopped after stays written.
 */

use super::tests::{Fixture, NAME, ORIGINAL};
use super::*;
use crate::db::file_writes::{
    begin_batch, clear_sweep, insert_journal, set_phase, SweepEntry, UndoDraft,
};
use crate::file_writes::fault::{Aborted, Fault, Step};
use crate::file_writes::names::{backup_name, temp_name};
use crate::file_writes::replace::sync_path;

const ADDED: &[u8] = b", then written";

// The steps of a write as the writers take them. A stamp sweeps its backup once the undo row is in;
// a trim keeps it.
fn write(f: &Fixture, kind: &str, fault: Fault) -> Result<(), Aborted> {
    let conn = &f.conn;
    let (pre_size, pre_mtime) = file_stats_checked(&f.source()).unwrap();
    let batch = begin_batch(conn, kind, None, 1).unwrap();
    let row = JournalRow {
        op_id: f.op.clone(),
        batch_id: batch,
        kind: kind.to_string(),
        root_id: f.root_id,
        rel_path: NAME.to_string(),
        rel_key: String::new(),
        temp_name: temp_name(&f.op, NAME),
        backup_name: backup_name(&f.op, NAME),
        pre_size,
        pre_mtime,
        phase: String::new(),
        undo_json: None,
        target_undo_id: None,
        created_at: 1,
    };
    insert_journal(conn, &row).unwrap();
    fault.check(Step::Journaled)?;

    fs::copy(f.source(), f.temp()).unwrap();
    let mut bytes = fs::read(f.temp()).unwrap();
    bytes.extend_from_slice(ADDED);
    fs::write(f.temp(), bytes).unwrap();
    fault.check(Step::TempWritten)?;

    sync_path(&f.temp()).unwrap();
    let (post_size, post_mtime) = file_stats_checked(&f.temp()).unwrap();
    let stamp = kind == "stamp";
    let draft = UndoDraft {
        root_id: Some(f.root_id),
        rel_path: NAME.to_string(),
        prior_json: stamp.then(|| "{}".to_string()),
        written_json: stamp.then(|| "{}".to_string()),
        backup_name: (!stamp).then(|| row.backup_name.clone()),
        post_size,
        post_mtime,
        sweep: if stamp {
            vec![SweepEntry {
                name: row.backup_name.clone(),
                size: pre_size,
            }]
        } else {
            Vec::new()
        },
        ..UndoDraft::default()
    };
    let json = serde_json::to_string(&draft).unwrap();
    set_phase(conn, &f.op, "temp_synced", Some(&json)).unwrap();
    fault.check(Step::TempSynced)?;

    let done = replace(&f.source(), &f.temp(), &f.backup()).unwrap();
    assert_eq!(done, ReplaceOutcome::Replaced);
    set_hidden(&f.backup()).unwrap();
    set_phase(conn, &f.op, "replaced", None).unwrap();
    fault.check(Step::Replaced)?;

    sync_path(&f.source()).unwrap();
    fault.check(Step::SourceSynced)?;

    let finished = finish_file(conn, &f.op, 2).unwrap();
    fault.check(Step::Finished)?;

    if stamp {
        fs::remove_file(f.backup()).unwrap();
        clear_sweep(
            conn,
            finished.undo_id,
            std::slice::from_ref(&row.backup_name),
        )
        .unwrap();
    }
    fault.check(Step::Swept)
}

fn staged(f: &Fixture) -> Vec<String> {
    fs::read_dir(&f.root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".plisto-tmp-"))
        .collect()
}

#[test]
fn a_write_stopped_after_any_step_recovers_to_one_whole_file() {
    let written = [ORIGINAL, ADDED].concat();
    for kind in ["stamp", "trim"] {
        for (n, step) in Step::ALL.into_iter().enumerate() {
            let f = Fixture::new(&format!("fault_{kind}"), &format!("{n:016x}"));
            fs::write(f.source(), ORIGINAL).unwrap();
            assert_eq!(
                write(&f, kind, Fault::abort_after(step)),
                Err(Aborted(step))
            );

            let report = f.recover();
            sweep_pending(&f.conn, |_| true).unwrap();
            let committed = step >= Step::Finished;
            let expected: &[u8] = if committed { &written } else { ORIGINAL };
            assert_eq!(
                fs::read(f.source()).unwrap(),
                expected,
                "{kind} after {step:?}"
            );
            assert!(report.needs_attention.is_empty(), "{kind} after {step:?}");
            assert_eq!(f.rows(), 0, "{kind} after {step:?}");

            let kept = kind == "trim" && committed;
            let left = if kept {
                vec![backup_name(&f.op, NAME)]
            } else {
                Vec::new()
            };
            assert_eq!(staged(&f), left, "{kind} after {step:?}");
            if kept {
                assert_eq!(fs::read(f.backup()).unwrap(), ORIGINAL);
            }
        }
    }
}

#[test]
fn a_write_left_to_run_needs_no_recovery() {
    let f = Fixture::new("fault_none", "00000000000000ff");
    fs::write(f.source(), ORIGINAL).unwrap();
    assert_eq!(write(&f, "stamp", Fault::NONE), Ok(()));
    assert_eq!(f.recover(), WriteRecovery::default());
    assert!(staged(&f).is_empty());
}
