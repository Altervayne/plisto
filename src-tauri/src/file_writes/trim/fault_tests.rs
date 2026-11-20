/*
 * The real trim and its undo stopped after each durable step, then recovered and swept as the next
 * launch would. A trim stopped before its undo row is recorded comes back as the original, one
 * stopped after stays trimmed with its backup kept. An undo stopped before it finishes leaves the
 * trimmed file and the kept backup whole; one stopped after has put the original back and swept
 * both backups.
 */

use super::tests::{Fixture, NOW};
use super::*;
use crate::db::file_writes::undo_row;
use crate::file_writes::attrs::is_hidden;
use crate::file_writes::recover::{recover_root, sweep_pending};
use std::fs;

// Settles the folder's unfinished writes and sweeps, and returns what was left for the user.
fn recover(f: &Fixture) -> WriteRecovery {
    let mut report = WriteRecovery::default();
    recover_root(&f.conn, f.root_id, &f.root, NOW + 5, &mut report).unwrap();
    sweep_pending(&f.conn, |_| true).unwrap();
    report
}

// The bytes a whole trim writes.
fn cut_bytes() -> Vec<u8> {
    let f = Fixture::new("fault_ref");
    f.trim(Fault::NONE).unwrap();
    fs::read(f.source()).unwrap()
}

#[test]
fn a_trim_stopped_after_any_step_recovers_to_one_whole_file() {
    let cut = cut_bytes();
    for step in Step::ALL {
        let f = Fixture::new("fault_trim");
        let done = f.trim(Fault::abort_after(step));
        // The trim takes no step after Finished, so a stop there never comes.
        if step == Step::Swept {
            assert!(done.is_ok(), "after {step:?}");
        } else {
            assert_eq!(done.unwrap_err(), Halt::Aborted(step));
        }

        let report = recover(&f);
        assert!(report.needs_attention.is_empty(), "after {step:?}");
        assert_eq!(f.rows(), 0, "after {step:?}");
        let committed = step >= Step::Finished;
        let expected = if committed { &cut } else { &f.original };
        assert_eq!(&fs::read(f.source()).unwrap(), expected, "after {step:?}");
        assert!(!is_hidden(&f.source()).unwrap(), "after {step:?}");

        let staged = f.staged();
        if committed {
            assert_eq!(staged.len(), 1, "after {step:?}");
            assert_eq!(fs::read(f.root.join(&staged[0])).unwrap(), f.original);
        } else {
            assert_eq!(staged, Vec::<String>::new(), "after {step:?}");
        }
    }
}

#[test]
fn an_undo_stopped_after_any_step_keeps_the_backup_until_it_commits() {
    let cut = cut_bytes();
    for step in Step::ALL {
        let f = Fixture::new("fault_undo");
        let trimmed = f.trim(Fault::NONE).unwrap();
        let kept = f.root.join(&trimmed.backup_name);
        assert_eq!(
            f.undo(trimmed.undo_id, Fault::abort_after(step))
                .unwrap_err(),
            Halt::Aborted(step)
        );

        let report = recover(&f);
        assert!(report.needs_attention.is_empty(), "after {step:?}");
        assert_eq!(f.rows(), 0, "after {step:?}");
        let undo = undo_row(&f.conn, trimmed.undo_id).unwrap();
        if step >= Step::Finished {
            assert_eq!(fs::read(f.source()).unwrap(), f.original, "after {step:?}");
            assert_eq!(f.staged(), Vec::<String>::new(), "after {step:?}");
            assert_eq!(undo, None, "after {step:?}");
        } else {
            assert_eq!(fs::read(f.source()).unwrap(), cut, "after {step:?}");
            assert_eq!(
                f.staged(),
                vec![trimmed.backup_name.clone()],
                "after {step:?}"
            );
            assert_eq!(fs::read(&kept).unwrap(), f.original, "after {step:?}");
            assert_eq!(undo.map(|u| u.undone_at), Some(None), "after {step:?}");

            // The backup still serves a second undo.
            f.undo(trimmed.undo_id, Fault::NONE).unwrap();
            assert_eq!(fs::read(f.source()).unwrap(), f.original, "after {step:?}");
            assert_eq!(f.staged(), Vec::<String>::new(), "after {step:?}");
        }
    }
}
