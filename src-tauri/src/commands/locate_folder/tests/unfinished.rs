// Unfinished writes under the folder being located block the relink.

use super::*;

// Journals an unfinished write of `rel`, a path below the library folder.
fn journal(lib: &Lib, rel: &str) {
    use crate::db::file_writes::{begin_batch, insert_journal, JournalRow};
    let conn = lib.state.db.lock().unwrap();
    let batch = begin_batch(&conn, "trim", None, 1).unwrap();
    let row = JournalRow {
        op_id: "op".to_string(),
        batch_id: batch,
        kind: "trim".to_string(),
        root_id: lib.root_id,
        rel_path: rel.to_string(),
        rel_key: String::new(),
        temp_name: "t".to_string(),
        backup_name: "b".to_string(),
        pre_size: 1,
        pre_mtime: 1,
        phase: "journaled".to_string(),
        undo_json: None,
        target_undo_id: None,
        created_at: 1,
    };
    insert_journal(&conn, &row).unwrap();
}

#[test]
fn an_apply_is_refused_for_a_row_under_the_folder_but_not_for_one_beside_it() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    lib.file("a.mp3", 3);
    journal(&lib, &PathBuf::from("Old").join("deep").join("x.opus").to_string_lossy());
    let mut points = 0;
    let outcome = lib.apply(&lib.new_path(), &mut points);
    assert_eq!(
        outcome,
        LocateFolderOutcome::Refused {
            reason: LocateFolderRefusal::Failed {
                message: "unfinished writes".to_string()
            }
        }
    );
    assert_eq!(points, 0);

    lib.state
        .db
        .lock()
        .unwrap()
        .execute("DELETE FROM file_write_journal", [])
        .unwrap();
    journal(&lib, &PathBuf::from("OldBeside").join("x.opus").to_string_lossy());
    assert!(matches!(
        lib.apply(&lib.new_path(), &mut points),
        LocateFolderOutcome::Done { relinked: 1, .. }
    ));
}


#[test]
fn a_row_whose_folder_differs_only_by_case_still_blocks() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    lib.file("a.mp3", 3);
    journal(&lib, &PathBuf::from("OLD").join("deep").join("x.opus").to_string_lossy());
    let mut points = 0;
    assert!(matches!(
        lib.apply(&lib.new_path(), &mut points),
        LocateFolderOutcome::Refused { .. }
    ));
    assert_eq!(points, 0);
}
