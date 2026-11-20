use super::*;
use crate::db::file_writes::{begin_batch, insert_journal, kept_backups, set_phase, UndoDraft};
use rusqlite::params;
use std::collections::HashSet;
use crate::file_writes::names::{backup_name, temp_name};
use std::sync::atomic::{AtomicU32, Ordering};

pub(super) struct TempDir {
    pub path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("plisto_recover_{tag}_{}_{n}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub(super) const NAME: &str = "song.opus";
pub(super) const ORIGINAL: &[u8] = b"original bytes";
pub(super) const WRITTEN: &[u8] = b"written bytes, longer";

/// A library folder with its root row in an index file beside it, and the three names of op `op`
/// for `song.opus`. Fields drop in order, so the folder is deleted once the index is closed.
pub(super) struct Fixture {
    pub root: PathBuf,
    pub conn: Connection,
    pub root_id: i64,
    pub op: String,
    pub dir: TempDir,
}

impl Fixture {
    pub fn new(tag: &str, op: &str) -> Self {
        let dir = TempDir::new(tag);
        let root = dir.path.join("music");
        fs::create_dir_all(&root).unwrap();
        let conn = db::open_db(&dir.path.join("index.sqlite")).unwrap();
        let root_id = db::get_or_create_root(&conn, &root.to_string_lossy(), 1)
            .unwrap()
            .0;
        Fixture {
            root,
            conn,
            root_id,
            op: op.to_string(),
            dir,
        }
    }
    pub fn source(&self) -> PathBuf {
        self.root.join(NAME)
    }
    pub fn temp(&self) -> PathBuf {
        self.root.join(temp_name(&self.op, NAME))
    }
    pub fn backup(&self) -> PathBuf {
        self.root.join(backup_name(&self.op, NAME))
    }
    /// A full scan of the root, as a user rescan runs it, and what it reported of unfinished writes.
    pub fn scan(&self) -> (crate::dto::ScanSummary, WriteRecovery) {
        let roots = [crate::scan::ScanRoot {
            id: self.root_id,
            path: self.root.clone(),
            units: None,
        }];
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let db_path = self.dir.path.join("index.sqlite");
        let found = std::sync::Mutex::new(WriteRecovery::default());
        let summary = crate::scan::run_scan(&roots, &db_path, &cancel, 10, &HashMap::new(), |e| {
            if let crate::scan::ScanEmit::Recovered(report) = e {
                found.lock().unwrap().merge(report);
            }
        })
        .unwrap();
        (summary, found.into_inner().unwrap())
    }

    /// Journals the write of `song.opus` as it is on disk now, in `phase`, with an undo draft from
    /// `phase` `temp_synced` on.
    pub fn journal(&self, kind: &str, phase: &str) {
        let (pre_size, pre_mtime) = file_stats_checked(&self.source()).unwrap();
        let batch = begin_batch(&self.conn, kind.trim_end_matches("_undo"), None, 1).unwrap();
        insert_journal(
            &self.conn,
            &JournalRow {
                op_id: self.op.clone(),
                batch_id: batch,
                kind: kind.to_string(),
                root_id: self.root_id,
                rel_path: NAME.to_string(),
                rel_key: String::new(),
                temp_name: temp_name(&self.op, NAME),
                backup_name: backup_name(&self.op, NAME),
                pre_size,
                pre_mtime,
                phase: String::new(),
                undo_json: None,
                target_undo_id: None,
                created_at: 1,
            },
        )
        .unwrap();
        if phase != "journaled" {
            let draft = UndoDraft {
                backup_name: Some(backup_name(&self.op, NAME)),
                ..UndoDraft::default()
            };
            let json = serde_json::to_string(&draft).unwrap();
            set_phase(&self.conn, &self.op, phase, Some(&json)).unwrap();
        }
    }

    /// The source swapped for `WRITTEN`, the original kept hidden under the backup name.
    pub fn swap(&self) {
        fs::write(self.temp(), WRITTEN).unwrap();
        let done = replace(&self.source(), &self.temp(), &self.backup()).unwrap();
        assert_eq!(done, ReplaceOutcome::Replaced);
        set_hidden(&self.backup()).unwrap();
    }

    pub fn recover(&self) -> WriteRecovery {
        let mut report = WriteRecovery::default();
        recover_root(&self.conn, self.root_id, &self.root, 5, &mut report).unwrap();
        report
    }
    pub fn rows(&self) -> usize {
        journal_rows(&self.conn, self.root_id).unwrap().len()
    }
    pub fn read(&self, path: &Path) -> Option<Vec<u8>> {
        fs::read(path).ok()
    }
    /// Names a kept backup on a live undo row, as a trim does.
    pub fn keep(&self, name: &str) {
        self.conn
            .execute(
                "INSERT INTO file_write_undo (batch_id, kind, root_path, rel_path, title, post_size,
                    post_mtime, backup_name)
                 VALUES ((SELECT MAX(id) FROM file_write_batches), 'trim', '', 'x', '', 0, 0, ?1)",
                params![name],
            )
            .unwrap();
    }
}

pub(super) fn attention(f: &Fixture) -> Vec<String> {
    vec![f.source().to_string_lossy().into_owned()]
}

#[test]
fn an_untouched_source_loses_its_temp() {
    let f = Fixture::new("untouched", "0000000000000001");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "temp_synced");
    fs::write(f.temp(), WRITTEN).unwrap();

    assert_eq!(f.recover(), WriteRecovery::default());
    assert_eq!(f.read(&f.source()).as_deref(), Some(ORIGINAL));
    assert!(!f.temp().exists());
    assert_eq!(f.rows(), 0);
}

#[test]
fn a_written_source_gets_its_backup_swapped_back() {
    let f = Fixture::new("written", "0000000000000002");
    fs::write(f.source(), ORIGINAL).unwrap();
    let pre = file_stats_checked(&f.source()).unwrap();
    f.journal("trim", "replaced");
    f.swap();

    let report = f.recover();
    assert_eq!((report.restored, report.needs_attention.len()), (1, 0));
    assert_eq!(f.read(&f.source()).as_deref(), Some(ORIGINAL));
    assert_eq!(file_stats_checked(&f.source()).unwrap(), pre);
    assert!(!super::super::attrs::is_hidden(&f.source()).unwrap());
    assert!(!f.temp().exists() && !f.backup().exists());
    assert_eq!(f.rows(), 0);
}

#[test]
fn a_missing_source_gets_its_backup_renamed_back() {
    for with_temp in [true, false] {
        let f = Fixture::new("missing", "0000000000000003");
        fs::write(f.source(), ORIGINAL).unwrap();
        f.journal("trim", "replaced");
        fs::rename(f.source(), f.backup()).unwrap();
        set_hidden(&f.backup()).unwrap();
        if with_temp {
            fs::write(f.temp(), WRITTEN).unwrap();
        }

        assert_eq!(f.recover().restored, 1);
        assert_eq!(f.read(&f.source()).as_deref(), Some(ORIGINAL));
        assert!(!super::super::attrs::is_hidden(&f.source()).unwrap());
        assert!(!f.temp().exists() && !f.backup().exists());
        assert_eq!(f.rows(), 0);
    }
}

#[test]
fn a_lone_synced_temp_is_moved_into_place_and_an_unsynced_one_held() {
    let f = Fixture::new("lone", "0000000000000004");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "journaled");
    fs::remove_file(f.source()).unwrap();
    fs::write(f.temp(), WRITTEN).unwrap();

    let held = f.recover();
    assert_eq!(held.needs_attention, attention(&f));
    assert_eq!(f.read(&f.temp()).as_deref(), Some(WRITTEN));
    assert!(!f.source().exists());
    assert_eq!(f.rows(), 1);

    f.conn
        .execute("UPDATE file_write_journal SET phase = 'temp_synced'", [])
        .unwrap();
    let moved = f.recover();
    assert_eq!((moved.restored, moved.needs_attention), (0, attention(&f)));
    assert_eq!(f.read(&f.source()).as_deref(), Some(WRITTEN));
    assert!(!f.temp().exists());
    assert_eq!(f.rows(), 0);
}

#[test]
fn a_committed_write_whose_backup_was_lost_is_finished() {
    let f = Fixture::new("lost", "0000000000000005");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "replaced");
    f.swap();
    fs::remove_file(f.backup()).unwrap();

    assert_eq!(f.recover().finished, 1);
    assert_eq!(f.read(&f.source()).as_deref(), Some(WRITTEN));
    assert_eq!(f.rows(), 0);
    assert_eq!(kept_backups(&f.conn).unwrap().len(), 1);
}

#[test]
fn a_changed_source_with_nothing_to_explain_it_is_left_alone() {
    let f = Fixture::new("unexplained", "0000000000000006");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "journaled");
    fs::write(f.source(), WRITTEN).unwrap();
    assert_eq!(f.recover().needs_attention, attention(&f));
    assert_eq!(f.read(&f.source()).as_deref(), Some(WRITTEN));
    assert_eq!(f.rows(), 1);

    fs::remove_file(f.source()).unwrap();
    assert_eq!(f.recover().needs_attention, attention(&f));
    assert_eq!(f.rows(), 1);
    assert_eq!(fs::read_dir(&f.root).unwrap().count(), 0);
}

#[test]
fn a_kept_backup_is_never_deleted_or_renamed_away() {
    // An undo's temp is the kept backup: an untouched source drops the row and leaves the file.
    let f = Fixture::new("guard1", "0000000000000007");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim_undo", "temp_synced");
    fs::write(f.temp(), WRITTEN).unwrap();
    f.keep(&temp_name(&f.op, NAME));
    assert_eq!(f.recover(), WriteRecovery::default());
    assert_eq!(f.read(&f.temp()).as_deref(), Some(WRITTEN));
    assert_eq!(f.rows(), 0);

    // A lone synced temp would be renamed into place: held instead.
    let f = Fixture::new("guard4", "0000000000000008");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim_undo", "temp_synced");
    fs::remove_file(f.source()).unwrap();
    fs::write(f.temp(), WRITTEN).unwrap();
    f.keep(&temp_name(&f.op, NAME));
    assert_eq!(f.recover().needs_attention, attention(&f));
    assert!(f.temp().exists() && !f.source().exists());
    assert_eq!(f.rows(), 1);

    // A missing source whose backup name is kept: held.
    let f = Fixture::new("guard3", "0000000000000009");
    fs::write(f.backup(), ORIGINAL).unwrap();
    fs::write(f.temp(), WRITTEN).unwrap();
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "replaced");
    fs::remove_file(f.source()).unwrap();
    f.keep(&backup_name(&f.op, NAME));
    assert_eq!(f.recover().needs_attention, attention(&f));
    assert!(f.temp().exists() && f.backup().exists());
}

#[test]
fn a_second_run_changes_nothing() {
    let f = Fixture::new("twice", "000000000000000b");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "replaced");
    f.swap();
    assert_eq!(f.recover().restored, 1);
    let listing = |f: &Fixture| {
        let mut names: Vec<_> = fs::read_dir(&f.root)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let before = listing(&f);
    assert_eq!(f.recover(), WriteRecovery::default());
    assert_eq!(listing(&f), before);
    assert_eq!(f.read(&f.source()).as_deref(), Some(ORIGINAL));

    // A held row is in every run's report, and reported once through the session's set.
    let held = Fixture::new("twice_held", "000000000000000c");
    fs::write(held.source(), ORIGINAL).unwrap();
    held.journal("trim", "journaled");
    fs::write(held.source(), WRITTEN).unwrap();
    let mut reported = HashSet::new();
    let first = held.recover();
    assert_eq!(held.recover(), first);
    assert_eq!(
        first.unreported(&mut reported).needs_attention,
        attention(&held)
    );
    assert!(held.recover().unreported(&mut reported).is_empty());
    assert_eq!(held.rows(), 1);
}

#[test]
fn a_path_that_leaves_the_root_is_held() {
    let f = Fixture::new("escape", "000000000000000d");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "journaled");
    // Each names the untouched source, which would otherwise drop the row.
    let outside = f.source().to_string_lossy().into_owned();
    for rel in [
        "..\\music\\song.opus",
        outside.as_str(),
        "\\song.opus",
        "x\\..\\song.opus",
        "",
    ] {
        f.conn
            .execute("UPDATE file_write_journal SET rel_path = ?1", params![rel])
            .unwrap();
        let row = journal_rows(&f.conn, f.root_id).unwrap().remove(0);
        assert_eq!(
            recover_row(&f.conn, &f.root, &row, 5).unwrap(),
            RowOutcome::Held
        );
    }
    assert_eq!(f.rows(), 1);
}

#[test]
fn a_temp_or_backup_name_that_is_more_than_a_file_name_is_held() {
    let f = Fixture::new("names", "000000000000000e");
    fs::write(f.source(), ORIGINAL).unwrap();
    f.journal("trim", "journaled");
    // As a temp name, this one would have the untouched source delete a file beside the root.
    let decoy = f.dir.path.join("decoy");
    fs::write(&decoy, WRITTEN).unwrap();
    for column in ["temp_name", "backup_name"] {
        for name in ["..\\decoy", "x\\t", "\\t", "C:\\t", "x/t", ""] {
            f.conn
                .execute(
                    &format!("UPDATE file_write_journal SET {column} = ?1"),
                    params![name],
                )
                .unwrap();
            let row = journal_rows(&f.conn, f.root_id).unwrap().remove(0);
            assert_eq!(
                recover_row(&f.conn, &f.root, &row, 5).unwrap(),
                RowOutcome::Held
            );
        }
        f.conn
            .execute(&format!("UPDATE file_write_journal SET {column} = 't'"), [])
            .unwrap();
    }
    assert_eq!(f.read(&decoy).as_deref(), Some(WRITTEN));
    assert_eq!(f.rows(), 1);
}
