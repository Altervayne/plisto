use super::*;
use crate::db::file_writes::{begin_batch, kept_backups, rewrite_expiry_from_setting, DAY_SECS};
use crate::file_writes::fault::Fault;
use crate::file_writes::trim::tests::{Fixture, NOW};
use std::fs::OpenOptions;
use std::io::Write;

pub(super) const LATER: i64 = NOW + 31 * DAY_SECS;

pub(super) fn online(_: &Path) -> bool {
    true
}

pub(super) fn never() -> bool {
    false
}

// A real trim of the fixture's file: its kept backup sits beside it under the row's name.
pub(super) fn trimmed(tag: &str) -> (Fixture, i64, PathBuf) {
    let f = Fixture::new(tag);
    let done = f.trim(Fault::NONE).unwrap();
    let backup = f.root.join(&done.backup_name);
    (f, done.undo_id, backup)
}

pub(super) fn append(path: &Path) {
    OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(b"x")
        .unwrap();
}

pub(super) fn rows(f: &Fixture) -> usize {
    kept_backups(&f.conn).unwrap().len()
}

// A kept-backup row of its own for `root`, with a backup file of `on_disk` bytes when given.
pub(super) fn plant(
    f: &Fixture,
    root: &Path,
    name: &str,
    recorded: i64,
    on_disk: Option<usize>,
) -> i64 {
    if let Some(len) = on_disk {
        fs::write(root.join(name), vec![7u8; len]).unwrap();
    }
    let batch = begin_batch(&f.conn, "trim", None, NOW).unwrap();
    let root_id: i64 = f
        .conn
        .query_row(
            "SELECT id FROM roots WHERE path = ?1",
            [root.to_string_lossy()],
            |r| r.get(0),
        )
        .unwrap();
    f.conn
        .execute(
            "INSERT INTO file_write_undo (batch_id, kind, root_id, root_path, rel_path, title,
                backup_name, backup_size, post_size, post_mtime, expires_at)
             VALUES (?1, 'trim', ?2, ?3, 'a.opus', 'A', ?4, ?5, 0, 0, ?6)",
            params![
                batch,
                root_id,
                root.to_string_lossy(),
                name,
                recorded,
                NOW + DAY_SECS
            ],
        )
        .unwrap();
    f.conn.last_insert_rowid()
}

#[test]
fn expiry_deletes_the_file_then_the_row_and_nothing_else() {
    let (f, _, backup) = trimmed("bk_expire");
    let stray = f.root.join(".plisto-tmp-bak-stray");
    fs::write(&stray, b"not in any row").unwrap();
    assert_eq!(
        expire(&f.conn, NOW + DAY_SECS, online, never).unwrap(),
        0,
        "not due yet"
    );
    assert!(backup.exists());

    assert_eq!(expire(&f.conn, LATER, online, never).unwrap(), 1);

    assert!(!backup.exists());
    assert_eq!(rows(&f), 0);
    assert!(stray.exists(), "a file no row names is never deleted");
    assert!(f.source().exists());
}

#[test]
fn expiry_keeps_a_backup_whose_size_changed() {
    let (f, _, backup) = trimmed("bk_altered");
    append(&backup);

    assert_eq!(expire(&f.conn, LATER, online, never).unwrap(), 0);

    assert!(backup.exists());
    assert_eq!(rows(&f), 1);
}

#[test]
fn expiry_keeps_the_row_and_the_file_of_an_offline_root() {
    let (f, _, backup) = trimmed("bk_offline");

    assert_eq!(expire(&f.conn, LATER, |_| false, never).unwrap(), 0);

    assert!(backup.exists());
    assert_eq!(rows(&f), 1);
}

#[test]
fn expiry_drops_the_row_of_a_missing_backup() {
    let (f, _, backup) = trimmed("bk_gone");
    fs::remove_file(&backup).unwrap();

    assert_eq!(expire(&f.conn, LATER, online, never).unwrap(), 1);

    assert_eq!(rows(&f), 0);
}

#[test]
fn a_changed_limit_rewrites_every_expiry_including_to_never() {
    let (f, id, backup) = trimmed("bk_limit");
    let expiry = |f: &Fixture| undo_row(&f.conn, id).unwrap().unwrap().expires_at;
    assert_eq!(expiry(&f), Some(NOW + 30 * DAY_SECS));

    db::set_setting(&f.conn, "trimBackupDays", "7").unwrap();
    rewrite_expiry_from_setting(&f.conn).unwrap();
    assert_eq!(expiry(&f), Some(NOW + 7 * DAY_SECS));

    db::set_setting(&f.conn, "trimBackupDays", "never").unwrap();
    rewrite_expiry_from_setting(&f.conn).unwrap();
    assert_eq!(expiry(&f), None);
    assert_eq!(expire(&f.conn, i64::MAX, online, never).unwrap(), 0);
    assert!(backup.exists());
}

#[test]
fn discarding_deletes_the_file_and_the_row() {
    let (f, id, backup) = trimmed("bk_discard");

    assert_eq!(discard(&f.conn, id, online), Ok(false));

    assert!(!backup.exists());
    assert_eq!(rows(&f), 0);
    assert_eq!(
        discard(&f.conn, id, online),
        Ok(false),
        "a second ask is nothing to do"
    );
}

#[test]
fn discarding_a_missing_backup_drops_the_row() {
    let (f, id, backup) = trimmed("bk_discard_gone");
    fs::remove_file(&backup).unwrap();

    assert_eq!(discard(&f.conn, id, online), Ok(false));

    assert_eq!(rows(&f), 0);
}

#[test]
fn discarding_on_an_offline_root_is_refused_and_changes_nothing() {
    let (f, id, backup) = trimmed("bk_discard_offline");

    assert_eq!(discard(&f.conn, id, |_| false), Err("offline".to_string()));

    assert!(backup.exists());
    assert_eq!(rows(&f), 1);
}

#[test]
fn discarding_a_changed_file_drops_the_row_and_keeps_the_file() {
    let (f, id, backup) = trimmed("bk_discard_altered");
    append(&backup);

    assert_eq!(discard(&f.conn, id, online), Ok(true));

    assert!(backup.exists());
    assert_eq!(rows(&f), 0);
}

#[test]
fn discard_all_counts_each_outcome() {
    let (f, _, backup) = trimmed("bk_all");
    let away = f.dir.path.join("away");
    fs::create_dir_all(&away).unwrap();
    db::get_or_create_root(&f.conn, &away.to_string_lossy(), 2).unwrap();
    let altered = plant(&f, &f.root, ".plisto-tmp-bak-alt", 5, Some(6));
    plant(&f, &f.root, ".plisto-tmp-bak-gone", 5, None);
    plant(&f, &away, ".plisto-tmp-bak-far", 5, Some(5));

    let out = discard_all(&f.conn, |root| root != away).unwrap();

    assert_eq!(
        out,
        KeptDiscardAllOutcome {
            discarded: 3,
            left_in_place: 1,
            offline: 1,
            failed: 0
        }
    );
    assert!(!backup.exists());
    assert!(f.root.join(".plisto-tmp-bak-alt").exists());
    assert!(away.join(".plisto-tmp-bak-far").exists());
    assert_eq!(rows(&f), 1);
    assert_ne!(kept_backups(&f.conn).unwrap()[0].id, altered);
}

pub(super) fn listed(
    f: &Fixture,
    trim_on: bool,
    reachable: impl FnMut(&Path) -> bool,
) -> KeptBackup {
    let mut all = describe(kept_places(&f.conn).unwrap(), trim_on, reachable);
    assert_eq!(all.len(), 1);
    all.remove(0)
}

#[test]
fn the_list_carries_the_row_and_says_when_it_can_be_undone() {
    let (f, id, _) = trimmed("bk_list");

    let row = listed(&f, true, online);

    assert_eq!(
        (row.undo_id, row.state, row.can_undo),
        (id, KeptState::Kept, true)
    );
    assert_eq!(row.track_id, Some(f.track_id));
    assert_eq!(row.root_id, Some(f.root_id));
    assert_eq!(row.title, "Song");
    assert_eq!(row.root_label, "music");
    assert_eq!(row.kept_at, NOW * 1000);
    assert_eq!(row.expires_at, Some((NOW + 30 * DAY_SECS) * 1000));
    assert_eq!(row.original_duration_ms, Some(2_000));
    assert!(row.trimmed_duration_ms.is_some());
    assert!(row.size > 0);
}

#[test]
fn the_list_tells_missing_and_offline_apart() {
    let (f, _, backup) = trimmed("bk_list_states");

    assert_eq!(listed(&f, true, |_| false).state, KeptState::Offline);
    assert!(!listed(&f, true, |_| false).can_undo);

    fs::remove_file(&backup).unwrap();
    let row = listed(&f, true, online);
    assert_eq!(row.state, KeptState::Missing);
    assert!(!row.can_undo);
}

#[test]
fn undo_is_not_offered_with_the_switch_off() {
    let (f, _, _) = trimmed("bk_list_off");

    assert!(!listed(&f, false, online).can_undo);
}

#[test]
fn undo_is_not_offered_once_the_track_is_gone() {
    let (f, _, _) = trimmed("bk_list_track");
    f.conn.execute("DELETE FROM tracks", []).unwrap();

    let row = listed(&f, true, online);

    assert_eq!(
        (row.track_id, row.state, row.can_undo),
        (None, KeptState::Kept, false)
    );
}

#[test]
fn undo_is_not_offered_once_the_root_is_gone() {
    let (f, _, backup) = trimmed("bk_list_root");
    f.conn
        .execute("UPDATE file_write_undo SET root_id = NULL", [])
        .unwrap();
    f.conn.execute("DELETE FROM roots", []).unwrap();

    let row = listed(&f, true, online);

    assert_eq!(
        (row.root_id, row.state, row.can_undo),
        (None, KeptState::Kept, false)
    );
    assert_eq!(
        discard(&f.conn, row.undo_id, online),
        Ok(false),
        "found by its snapshot"
    );
    assert!(!backup.exists());
}

#[test]
fn undo_is_not_offered_once_the_file_changed_since_the_trim() {
    let (f, _, _) = trimmed("bk_list_changed");
    append(&f.source());

    let row = listed(&f, true, online);

    assert_eq!((row.state, row.can_undo), (KeptState::Kept, false));
}

#[test]
fn the_hourly_turn_expires_backups_unless_a_write_runs_or_the_lock_is_held() {
    let (f, _, backup) = trimmed("bk_turn");
    let mut state = AppState::for_test(db::open_db(&f.db_path).unwrap(), f.dir.path.join("c"));
    state.db_path = f.db_path.clone();

    state.file_write_running.store(true, Ordering::SeqCst);
    assert!(!hourly_turn(&state, LATER, online));
    state.file_write_running.store(false, Ordering::SeqCst);
    {
        let _held = acquire_scan_lock(&state, Holder::User).unwrap();
        assert!(!hourly_turn(&state, LATER, online));
    }
    assert!(backup.exists());
    assert_eq!(rows(&f), 1);

    assert!(hourly_turn(&state, LATER, online));

    assert!(!backup.exists());
    assert_eq!(rows(&f), 0);
    assert!(
        state.scan_holder.lock().unwrap().is_none(),
        "the lock is released"
    );
}
