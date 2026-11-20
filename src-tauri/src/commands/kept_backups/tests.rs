use super::*;
use crate::file_writes::fault::Fault;
use crate::file_writes::trim::tests::Fixture;
use crate::scan_lock::WRITE_BUSY;
use std::sync::atomic::Ordering;

// The command state over a fixture with one trimmed file. The trim switch is left off: discarding
// does not depend on it.
fn lib(tag: &str) -> (AppState, Fixture, std::path::PathBuf) {
    let f = Fixture::new(tag);
    let done = f.trim(Fault::NONE).unwrap();
    let backup = f.root.join(&done.backup_name);
    let mut state = AppState::for_test(db::open_db(&f.db_path).unwrap(), f.dir.path.join("covers"));
    state.db_path = f.db_path.clone();
    (state, f, backup)
}

#[test]
fn the_list_is_a_read_and_needs_no_lock_or_switch() {
    let (state, f, _) = lib("kb_cmd_list");
    let _held = acquire_scan_lock(&state, Holder::User).unwrap();
    state.file_write_running.store(true, Ordering::SeqCst);

    let rows = list(&state).unwrap();

    assert_eq!(rows.len(), 1);
    assert!(!rows[0].can_undo, "the switch is off");
    assert_eq!(rows[0].track_id, Some(f.track_id));
}

#[test]
fn discarding_works_with_the_trim_switch_off() {
    let (state, f, backup) = lib("kb_cmd_discard");
    let id = list(&state).unwrap()[0].undo_id;

    let out = discard_one(&state, id).unwrap();

    assert!(!out.left_in_place);
    assert!(!backup.exists());
    assert!(f.source().exists());
    assert!(list(&state).unwrap().is_empty());
    assert!(!state.file_write_running.load(Ordering::SeqCst));
}

#[test]
fn discarding_is_refused_while_a_file_write_runs() {
    let (state, _, backup) = lib("kb_cmd_busy");
    let id = list(&state).unwrap()[0].undo_id;
    state.file_write_running.store(true, Ordering::SeqCst);

    assert_eq!(discard_one(&state, id).unwrap_err(), WRITE_BUSY);
    assert_eq!(discard_every(&state).unwrap_err(), WRITE_BUSY);

    assert!(backup.exists());
}

#[test]
fn discarding_is_refused_while_the_scan_lock_is_held_for_a_write() {
    let (state, _, backup) = lib("kb_cmd_lock");
    let id = list(&state).unwrap()[0].undo_id;
    let _write = acquire_scan_lock(&state, Holder::FileWrite).unwrap();

    assert_eq!(discard_one(&state, id).unwrap_err(), WRITE_BUSY);

    assert!(backup.exists());
}

#[test]
fn discard_all_reports_its_counts() {
    let (state, _, backup) = lib("kb_cmd_all");

    let out = discard_every(&state).unwrap();

    assert_eq!(
        (out.discarded, out.left_in_place, out.offline, out.failed),
        (1, 0, 0, 0)
    );
    assert!(!backup.exists());
}
