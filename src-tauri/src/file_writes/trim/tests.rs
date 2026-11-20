use super::*;
use crate::audio::stream::test_media::ogg_opus_tagged;
use crate::db::file_writes::{journal_rows, undo_row};
use crate::file_writes::attrs::is_hidden;
use crate::scan::{run_scan, ScanRoot};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

pub(crate) const NAME: &str = "song.opus";
pub(crate) const NOW: i64 = 1_000;

pub(crate) struct TempDir {
    pub path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("plisto_trim_{tag}_{}_{n}", std::process::id()));
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

// An OpusTags packet with one TITLE comment.
fn opus_tags(title: &str) -> Vec<u8> {
    let comment = format!("TITLE={title}");
    let mut tags = b"OpusTags".to_vec();
    tags.extend_from_slice(&4u32.to_le_bytes());
    tags.extend_from_slice(b"test");
    tags.extend_from_slice(&1u32.to_le_bytes());
    tags.extend_from_slice(&(comment.len() as u32).to_le_bytes());
    tags.extend_from_slice(comment.as_bytes());
    tags
}

/// A library folder holding one scanned two-second Opus file, `song.opus`, with its index file
/// beside it. The folder is the last field, so it is deleted once the index is closed.
pub(crate) struct Fixture {
    pub root: PathBuf,
    pub db_path: PathBuf,
    pub conn: Connection,
    pub root_id: i64,
    pub track_id: i64,
    pub original: Vec<u8>,
    pub dir: TempDir,
}

impl Fixture {
    pub fn new(tag: &str) -> Self {
        let dir = TempDir::new(tag);
        let root = dir.path.join("music");
        fs::create_dir_all(&root).unwrap();
        let db_path = dir.path.join("index.sqlite");
        let conn = db::open_db(&db_path).unwrap();
        let root_id = db::get_or_create_root(&conn, &root.to_string_lossy(), 1)
            .unwrap()
            .0;
        let original = ogg_opus_tagged(7, 2, 100, 312, opus_tags("Song"));
        fs::write(root.join(NAME), &original).unwrap();
        let roots = [ScanRoot {
            id: root_id,
            path: root.clone(),
            units: None,
        }];
        let cancel = Arc::new(AtomicBool::new(false));
        run_scan(&roots, &db_path, &cancel, 10, &HashMap::new(), |_| {}).unwrap();
        let track_id = conn
            .query_row("SELECT id FROM tracks", [], |r| r.get(0))
            .unwrap();
        Fixture {
            root,
            db_path,
            conn,
            root_id,
            track_id,
            original,
            dir,
        }
    }

    pub fn source(&self) -> PathBuf {
        self.root.join(NAME)
    }

    /// The file as it is on disk now.
    pub fn file(&self) -> TrimFile {
        let (size, mtime) = file_stats_checked(&self.source()).unwrap();
        TrimFile {
            track_id: self.track_id,
            root_id: self.root_id,
            root: self.root.clone(),
            rel_path: NAME.to_string(),
            source: self.source(),
            title: "Song".to_string(),
            size,
            mtime,
            duration_ms: Some(2_000),
        }
    }

    pub fn trim(&self, fault: Fault) -> Result<Trimmed, Halt> {
        let mut run = WriteRun::new(&self.conn, fault, NOW);
        trim_in_place(&mut run, &self.file(), &segment(), Some(30), &|| false)
    }

    pub fn undo(&self, undo_id: i64, fault: Fault) -> Result<Vec<i64>, Halt> {
        let undo = undo_row(&self.conn, undo_id).unwrap().unwrap();
        let mut run = WriteRun::new(&self.conn, fault, NOW + 1);
        undo_trim(&mut run, &self.file(), &undo)
    }

    /// The staging files in the folder, sorted.
    pub fn staged(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".plisto-tmp-"))
            .collect();
        names.sort();
        names
    }

    pub fn rows(&self) -> usize {
        journal_rows(&self.conn, self.root_id).unwrap().len()
    }
}

/// From 0.2 s to 1 s.
pub(crate) fn segment() -> Segment {
    Segment {
        start_frame: 9_600,
        end_frame: 48_000,
        title: None,
        artist: None,
        track_no: None,
    }
}

// The second Ogg packet, the OpusTags.
fn tags_packet(path: &Path) -> Vec<u8> {
    let mut reader = ogg::reading::PacketReader::new(fs::File::open(path).unwrap());
    reader.read_packet().unwrap().unwrap();
    reader.read_packet().unwrap().unwrap().data
}

#[test]
fn a_trim_swaps_in_the_cut_and_keeps_the_original_hidden() {
    let f = Fixture::new("swap");
    let trimmed = f.trim(Fault::NONE).unwrap();

    let backup = f.root.join(&trimmed.backup_name);
    assert!(trimmed.backup_name.starts_with(".plisto-tmp-bak-"));
    assert!(trimmed.backup_name.ends_with(NAME));
    assert_eq!(fs::read(&backup).unwrap(), f.original);
    assert!(is_hidden(&backup).unwrap());
    assert_eq!(f.staged(), vec![trimmed.backup_name.clone()]);
    let cut = fs::read(f.source()).unwrap();
    assert!(cut.len() < f.original.len());
    assert_eq!(tags_packet(&f.source()), tags_packet(&backup));
    assert_eq!(tags_packet(&f.source()), opus_tags("Song"));

    let (size, mtime) = file_stats_checked(&f.source()).unwrap();
    let undo = undo_row(&f.conn, trimmed.undo_id).unwrap().unwrap();
    assert_eq!(undo.kind, "trim");
    assert_eq!(
        undo.backup_name.as_deref(),
        Some(trimmed.backup_name.as_str())
    );
    assert_eq!(undo.backup_size, Some(f.original.len() as i64));
    assert_eq!((undo.post_size, undo.post_mtime), (size, mtime));
    assert_eq!(undo.pre_duration_ms, Some(2_000));
    assert_eq!(undo.post_duration_ms, Some(800));
    assert_eq!(undo.expires_at, Some(NOW + 30 * DAY_SECS));
    assert_eq!(trimmed.expires_at, undo.expires_at);
    assert_eq!(f.rows(), 0);

    assert_eq!(trimmed.reread, vec![f.track_id]);
    let row: (i64, i64) = f
        .conn
        .query_row(
            "SELECT size_bytes, mtime FROM tracks WHERE id = ?1",
            [f.track_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, (size, mtime));
}

#[test]
fn a_trim_kept_until_discarded_has_no_expiry() {
    let f = Fixture::new("never");
    let mut run = WriteRun::new(&f.conn, Fault::NONE, NOW);
    let trimmed = trim_in_place(&mut run, &f.file(), &segment(), None, &|| false).unwrap();
    assert_eq!(trimmed.expires_at, None);
    let undo = undo_row(&f.conn, trimmed.undo_id).unwrap().unwrap();
    assert_eq!(undo.expires_at, None);
}

#[test]
fn an_undo_puts_the_original_back_and_sweeps_both_backups() {
    let f = Fixture::new("undo");
    let (_, original_mtime) = file_stats_checked(&f.source()).unwrap();
    let trimmed = f.trim(Fault::NONE).unwrap();

    let reread = f.undo(trimmed.undo_id, Fault::NONE).unwrap();
    assert_eq!(fs::read(f.source()).unwrap(), f.original);
    assert_eq!(file_stats_checked(&f.source()).unwrap().1, original_mtime);
    assert!(!is_hidden(&f.source()).unwrap());
    assert_eq!(f.staged(), Vec::<String>::new());
    assert_eq!(undo_row(&f.conn, trimmed.undo_id).unwrap(), None);
    assert_eq!(f.rows(), 0);
    assert_eq!(reread, vec![f.track_id]);
}

#[test]
fn a_cancel_before_the_trim_starts_writes_nothing() {
    let f = Fixture::new("cancel");
    let mut run = WriteRun::new(&f.conn, Fault::NONE, NOW);
    let halt = trim_in_place(&mut run, &f.file(), &segment(), Some(30), &|| true).unwrap_err();
    assert_eq!(halt, Halt::Failed(TrimFailure::Cancelled));
    assert_eq!(halt.to_string(), "cancelled");
    assert_eq!(fs::read(f.source()).unwrap(), f.original);
    assert_eq!(f.staged(), Vec::<String>::new());
    assert_eq!(f.rows(), 0);
}

#[test]
fn a_cancel_once_the_cut_is_synced_stops_before_the_swap() {
    let f = Fixture::new("cancel_swap");
    // Asked at each step, the cancel answers yes once the journal row has reached temp_synced.
    let synced = || {
        journal_rows(&f.conn, f.root_id)
            .unwrap()
            .iter()
            .any(|row| row.phase == "temp_synced")
    };
    let mut run = WriteRun::new(&f.conn, Fault::NONE, NOW);
    let halt = trim_in_place(&mut run, &f.file(), &segment(), Some(30), &synced).unwrap_err();
    assert_eq!(halt, Halt::Failed(TrimFailure::Cancelled));
    assert_eq!(fs::read(f.source()).unwrap(), f.original);
    assert_eq!(f.staged(), Vec::<String>::new());
    assert_eq!(f.rows(), 0);
}

#[test]
fn an_undo_refuses_a_kept_backup_that_changed_size() {
    let f = Fixture::new("undo_altered");
    let trimmed = f.trim(Fault::NONE).unwrap();
    let cut = fs::read(f.source()).unwrap();
    let kept = f.root.join(&trimmed.backup_name);
    let mut altered = f.original.clone();
    altered.extend_from_slice(b"appended");
    fs::write(&kept, &altered).unwrap();

    let halt = f.undo(trimmed.undo_id, Fault::NONE).unwrap_err();
    assert_eq!(halt, Halt::Failed(TrimFailure::Missing));
    assert_eq!(fs::read(f.source()).unwrap(), cut);
    assert_eq!(fs::read(&kept).unwrap(), altered);
    assert_eq!(f.staged(), vec![trimmed.backup_name.clone()]);
    assert_eq!(f.rows(), 0);
    let undo = undo_row(&f.conn, trimmed.undo_id).unwrap().unwrap();
    assert_eq!(undo.undone_at, None);
}

#[test]
fn a_put_back_copy_of_another_size_is_refused() {
    let f = Fixture::new("copy_short");
    let copy = f.root.join("copy.opus");
    fs::write(&copy, &f.original[..100]).unwrap();
    let whole = f.original.len() as i64;
    assert_eq!(
        undo::check_copied(&copy, whole),
        Err(Halt::Failed(TrimFailure::Missing))
    );
    assert_eq!(undo::check_copied(&copy, 100), Ok(()));
}

#[test]
fn a_failed_cut_settles_its_row_and_leaves_the_original() {
    let f = Fixture::new("badcut");
    let garbage = b"not an Ogg stream".to_vec();
    fs::write(f.source(), &garbage).unwrap();
    let halt = f.trim(Fault::NONE).unwrap_err();
    assert!(halt.to_string().starts_with("other: "), "{halt}");
    assert_eq!(fs::read(f.source()).unwrap(), garbage);
    assert_eq!(f.staged(), Vec::<String>::new());
    assert_eq!(f.rows(), 0);
}

#[test]
fn file_system_codes_map_to_the_kinds_the_editor_reads() {
    let kind = |code| TrimFailure::of_io(&io::Error::from_raw_os_error(code));
    assert_eq!(kind(5), TrimFailure::Denied);
    assert_eq!(kind(32), TrimFailure::Locked);
    assert_eq!(kind(33), TrimFailure::Locked);
    assert_eq!(kind(39), TrimFailure::Space);
    assert_eq!(kind(112), TrimFailure::Space);
    assert_eq!(kind(2), TrimFailure::Other("2".to_string()));
    assert_eq!(TrimFailure::of_held(5), TrimFailure::Locked);
    assert_eq!(TrimFailure::of_held(32), TrimFailure::Locked);
    assert_eq!(TrimFailure::of_held(112), TrimFailure::Space);
    assert_eq!(
        TrimFailure::of_held(1177),
        TrimFailure::Other("1177".to_string())
    );
}

#[test]
fn failures_display_as_their_kind_then_any_detail() {
    let shown = [
        (TrimFailure::Locked, "locked"),
        (TrimFailure::Space, "space"),
        (TrimFailure::Denied, "denied"),
        (TrimFailure::Changed, "changed"),
        (TrimFailure::InUse, "inUse"),
        (TrimFailure::Offline, "offline"),
        (TrimFailure::Missing, "missing"),
        (
            TrimFailure::Busy("an export is running"),
            "busy: an export is running",
        ),
        (
            TrimFailure::Unavailable("not an Opus file"),
            "unavailable: not an Opus file",
        ),
        (TrimFailure::Other("1176".to_string()), "other: 1176"),
        (TrimFailure::Cancelled, "cancelled"),
    ];
    for (failure, want) in shown {
        assert_eq!(failure.to_string(), want);
        assert_eq!(Halt::Failed(failure).to_string(), want);
    }
    assert_eq!(
        Halt::Aborted(Step::Replaced).to_string(),
        "other: stopped after Replaced"
    );
}
