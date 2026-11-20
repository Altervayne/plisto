use super::tests::{append, listed, online, rows, trimmed};
use super::*;
use crate::file_writes::trim::tests::NAME;
use std::time::{Duration, SystemTime};

// The folder's root as a path of its own: the drive, which is what a removed root is asked about.
fn drive_of(root: &Path) -> PathBuf {
    root.ancestors().last().unwrap().to_path_buf()
}

#[test]
fn a_removed_root_reads_missing_while_its_drive_answers_and_offline_while_it_does_not() {
    let (f, _, _) = trimmed("bk_gone_root");
    f.conn
        .execute("UPDATE file_write_undo SET root_id = NULL", [])
        .unwrap();
    f.conn.execute("DELETE FROM roots", []).unwrap();
    fs::remove_dir_all(&f.root).unwrap();
    let drive = drive_of(&f.root);

    assert_eq!(listed(&f, true, |p| p == drive).state, KeptState::Missing);
    assert_eq!(listed(&f, true, |p| p != drive).state, KeptState::Offline);
    assert_eq!(
        discard(&f.conn, listed(&f, true, |p| p == drive).undo_id, |p| p
            == drive),
        Ok(false)
    );
    assert_eq!(rows(&f), 0);
}

#[test]
fn undo_is_not_offered_on_an_mtime_only_change_or_a_flagged_track() {
    let (f, _, _) = trimmed("bk_undo_gates");
    assert!(listed(&f, true, online).can_undo);

    let file = fs::OpenOptions::new().write(true).open(f.source()).unwrap();
    file.set_modified(SystemTime::now() + Duration::from_secs(3_600))
        .unwrap();
    drop(file);
    let row = listed(&f, true, online);
    assert_eq!((row.state, row.can_undo), (KeptState::Kept, false));

    let (f, _, _) = trimmed("bk_undo_flagged");
    f.conn
        .execute("UPDATE tracks SET missing_at = 5", [])
        .unwrap();
    let row = listed(&f, true, online);
    assert_eq!((row.state, row.can_undo), (KeptState::Kept, false));
}

#[test]
fn a_track_moved_to_another_folder_still_finds_its_backup() {
    let (f, id, backup) = trimmed("bk_moved");
    let other = f.dir.path.join("music").join("moved");
    fs::create_dir_all(&other).unwrap();
    fs::rename(f.source(), other.join(NAME)).unwrap();
    let moved = other.join(NAME).to_string_lossy().into_owned();
    f.conn
        .execute(
            "UPDATE tracks SET source_path = ?1, display_path = ?1",
            [&moved],
        )
        .unwrap();

    let row = listed(&f, true, online);

    assert_eq!((row.state, row.can_undo), (KeptState::Kept, false));
    assert_eq!(discard(&f.conn, id, online), Ok(false));
    assert!(!backup.exists());
    assert_eq!(rows(&f), 0);
    assert!(other.join(NAME).exists());
}

#[test]
fn a_backup_in_its_folder_is_undoable_until_it_is_altered() {
    let (f, _, backup) = trimmed("bk_beside");
    assert!(listed(&f, true, online).can_undo);

    append(&backup);

    assert!(!listed(&f, true, online).can_undo);
}
