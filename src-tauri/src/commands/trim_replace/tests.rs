use super::*;
use crate::audio::{PlayerStatus, QueueMirror};
use crate::dto::TrimExpect;
use crate::file_writes::trim::tests::{segment, Fixture};
use std::fs;
use std::os::windows::fs::OpenOptionsExt;

// The command state over a fixture library with trim in place on. The fixture is the last field, so
// the state's index closes before its folder is removed.
struct Lib {
    state: AppState,
    f: Fixture,
}

impl Lib {
    fn new(tag: &str) -> Self {
        let f = Fixture::new(tag);
        db::set_setting(&f.conn, "trimReplace", "1").unwrap();
        let mut state =
            AppState::for_test(db::open_db(&f.db_path).unwrap(), f.dir.path.join("covers"));
        state.db_path = f.db_path.clone();
        Lib { state, f }
    }

    fn job(&self) -> TrimReplaceJob {
        let (size_bytes, mtime) = file_stats_checked(&self.f.source()).unwrap();
        TrimReplaceJob {
            track_id: self.f.track_id,
            segment: segment(),
            expect: TrimExpect { size_bytes, mtime },
        }
    }

    fn trim(&self, job: &TrimReplaceJob) -> (Result<TrimReplaceResult, String>, Vec<i64>) {
        let mut changed = Vec::new();
        let done = replace_track(&self.state, job, |_| {}, || {}, Fault::NONE, &mut changed);
        (done, changed)
    }

    fn undo(&self, undo_id: i64) -> Result<(), String> {
        undo_track(&self.state, undo_id, Fault::NONE, &mut Vec::new())
    }

    fn play(&self, status: PlayerStatus, ids: &[i64]) {
        *self.state.player_status.lock().unwrap() = status;
        *self.state.player_queue.lock().unwrap() = QueueMirror {
            ids: ids.to_vec(),
            blocks: Vec::new(),
        };
    }

    fn untouched(&self) {
        assert_eq!(fs::read(self.f.source()).unwrap(), self.f.original);
        assert_eq!(self.f.staged(), Vec::<String>::new());
    }
}

#[test]
fn a_trim_reports_its_undo_and_ticks_to_done() {
    let lib = Lib::new("cmd_ok");
    let mut ticks = Vec::new();
    let mut points = 0;
    let mut changed = Vec::new();
    let done = replace_track(
        &lib.state,
        &lib.job(),
        |tick| ticks.push(format!("{:?} {}", tick.phase, tick.done)),
        || points += 1,
        Fault::NONE,
        &mut changed,
    )
    .unwrap();

    assert_eq!(points, 1);
    assert_eq!(ticks, vec!["Preparing false", "Cutting false", "Done true"]);
    assert_eq!(changed, vec![lib.f.track_id]);
    assert!(done.backup_name.starts_with(".plisto-tmp-bak-"));
    let expires = done.expires_at.unwrap();
    let days = (expires / 1000 - super::super::now_unix()) / 86_400;
    assert!((29..=30).contains(&days), "{days}");
    assert_eq!(lib.f.staged(), vec![done.backup_name.clone()]);
    assert!(!lib.state.file_write_running.load(Ordering::SeqCst));
}

#[test]
fn the_backup_lifetime_follows_the_setting() {
    let lib = Lib::new("cmd_days");
    let conn = lib.state.db.lock().unwrap();
    assert_eq!(backup_days(&conn), Some(30));
    for (value, days) in [
        ("7", Some(7)),
        ("30", Some(30)),
        ("never", None),
        ("9", Some(30)),
    ] {
        db::set_setting(&conn, "trimBackupDays", value).unwrap();
        assert_eq!(backup_days(&conn), days, "{value}");
    }
}

#[test]
fn only_opus_library_tracks_are_trimmed() {
    let lib = Lib::new("cmd_format");
    let unknown = TrimReplaceJob {
        track_id: lib.f.track_id + 100,
        ..lib.job()
    };
    let (done, _) = lib.trim(&unknown);
    assert_eq!(done.unwrap_err(), "unavailable: not a library track");

    for ext in ["flac", "mp3", "wav", "m4a"] {
        let path = lib.f.root.join(format!("song.{ext}"));
        lib.f
            .conn
            .execute(
                "UPDATE tracks SET display_path = ?1 WHERE id = ?2",
                rusqlite::params![path.to_string_lossy(), lib.f.track_id],
            )
            .unwrap();
        let (done, _) = lib.trim(&lib.job());
        assert_eq!(done.unwrap_err(), "unavailable: not an Opus file", "{ext}");
    }
    lib.untouched();
}

#[test]
fn a_write_is_refused_while_off_busy_or_running() {
    let lib = Lib::new("cmd_guard");
    lib.state.export_running.store(true, Ordering::SeqCst);
    assert_eq!(
        lib.trim(&lib.job()).0.unwrap_err(),
        "busy: an export is running"
    );
    lib.state.export_running.store(false, Ordering::SeqCst);

    lib.state.file_write_running.store(true, Ordering::SeqCst);
    assert_eq!(lib.trim(&lib.job()).0.unwrap_err(), WRITE_BUSY);
    lib.state.file_write_running.store(false, Ordering::SeqCst);

    db::set_setting(&lib.f.conn, "trimReplace", "0").unwrap();
    assert_eq!(
        lib.trim(&lib.job()).0.unwrap_err(),
        "unavailable: trim in place is off"
    );
    assert_eq!(
        lib.undo(1).unwrap_err(),
        "unavailable: trim in place is off"
    );
    lib.untouched();
}

#[test]
fn a_library_row_unlike_the_analysis_is_refused_as_changed() {
    let lib = Lib::new("cmd_row");
    let mut job = lib.job();
    job.expect.size_bytes += 1;
    let mut points = 0;
    let mut changed = Vec::new();
    let done = replace_track(
        &lib.state,
        &job,
        |_| {},
        || points += 1,
        Fault::NONE,
        &mut changed,
    );
    assert_eq!(done.unwrap_err(), "changed");
    assert_eq!(points, 0);
    assert_eq!(changed, Vec::<i64>::new());
    lib.untouched();
}

#[test]
fn a_file_unlike_its_row_is_read_back_then_refused_as_changed() {
    let lib = Lib::new("cmd_disk");
    let job = lib.job();
    let moved = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_500_000_000);
    fs::File::options()
        .write(true)
        .open(lib.f.source())
        .unwrap()
        .set_modified(moved)
        .unwrap();

    let (done, changed) = lib.trim(&job);
    assert_eq!(done.unwrap_err(), "changed");
    assert_eq!(changed, vec![lib.f.track_id]);
    let mtime: i64 = lib
        .f
        .conn
        .query_row(
            "SELECT mtime FROM tracks WHERE id = ?1",
            [lib.f.track_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(mtime, file_stats_checked(&lib.f.source()).unwrap().1);
    assert_eq!(lib.trim(&lib.job()).0.map(|_| ()), Ok(()));
}

#[test]
fn a_gone_or_read_only_file_is_refused() {
    let lib = Lib::new("cmd_missing");
    let writable = fs::metadata(lib.f.source()).unwrap().permissions();
    let mut read_only = writable.clone();
    read_only.set_readonly(true);
    fs::set_permissions(lib.f.source(), read_only).unwrap();
    assert_eq!(lib.trim(&lib.job()).0.unwrap_err(), "denied");
    fs::set_permissions(lib.f.source(), writable).unwrap();

    let job = lib.job();
    fs::remove_file(lib.f.source()).unwrap();
    assert_eq!(lib.trim(&job).0.unwrap_err(), "missing");
}

#[test]
fn the_track_the_player_sounds_or_opens_next_is_in_use() {
    let lib = Lib::new("cmd_in_use");
    let id = lib.f.track_id;
    let playing = PlayerStatus {
        playing: true,
        track_id: Some(id),
        ..PlayerStatus::default()
    };
    lib.play(playing, &[id]);
    assert_eq!(lib.trim(&lib.job()).0.unwrap_err(), "inUse");

    let before = PlayerStatus {
        playing: true,
        track_id: Some(id + 1),
        ..PlayerStatus::default()
    };
    lib.play(before, &[id + 1, id]);
    assert_eq!(lib.trim(&lib.job()).0.unwrap_err(), "inUse");

    // A preview sounds the track with the player seated on nothing.
    let preview = PlayerStatus {
        playing: true,
        track_id: None,
        ..PlayerStatus::default()
    };
    lib.play(preview, &[id]);
    assert_eq!(lib.trim(&lib.job()).0.unwrap_err(), "inUse");
    lib.untouched();
}

#[test]
fn the_track_seated_but_not_sounding_is_trimmed() {
    let paused = PlayerStatus {
        playing: false,
        track_id: None,
        ..PlayerStatus::default()
    };
    // Paused on the track, then with its seat cleared by a stopped preview.
    for (n, seated) in [true, false].into_iter().enumerate() {
        let lib = Lib::new(&format!("cmd_seated_{n}"));
        let id = lib.f.track_id;
        let status = PlayerStatus {
            track_id: seated.then_some(id),
            ..paused.clone()
        };
        lib.play(status, &[id]);
        assert_eq!(
            lib.trim(&lib.job()).0.map(|_| ()),
            Ok(()),
            "seated {seated}"
        );
    }
}

#[test]
fn a_cancel_before_the_swap_rejects_as_cancelled() {
    let lib = Lib::new("cmd_cancel");
    let done = replace_track(
        &lib.state,
        &lib.job(),
        |_| {},
        || cancel_write(&lib.state),
        Fault::NONE,
        &mut Vec::new(),
    );
    assert_eq!(done.unwrap_err(), "cancelled");
    lib.untouched();
    assert_eq!(lib.f.rows(), 0);
}

#[test]
fn a_cancel_with_no_write_running_is_dropped() {
    let lib = Lib::new("cmd_cancel_idle");
    cancel_write(&lib.state);
    assert!(!lib.state.file_write_cancel.load(Ordering::SeqCst));
    assert_eq!(lib.trim(&lib.job()).0.map(|_| ()), Ok(()));
}

#[test]
fn a_track_under_an_unreachable_root_is_offline() {
    let lib = Lib::new("cmd_offline");
    let gone = lib.f.dir.path.join("unplugged");
    lib.f
        .conn
        .execute(
            "UPDATE roots SET path = ?1 WHERE id = ?2",
            params![gone.to_string_lossy(), lib.f.root_id],
        )
        .unwrap();
    assert_eq!(lib.trim(&lib.job()).0.unwrap_err(), "offline");
    lib.untouched();
}

#[test]
fn a_file_another_program_holds_is_locked() {
    let lib = Lib::new("cmd_locked");
    let job = lib.job();
    let held = fs::File::options()
        .read(true)
        .share_mode(0)
        .open(lib.f.source())
        .unwrap();
    assert_eq!(lib.trim(&job).0.unwrap_err(), "locked");
    drop(held);
    lib.untouched();
    assert_eq!(lib.f.rows(), 0);
}

#[test]
fn an_undo_puts_the_original_back_unless_the_file_changed() {
    let lib = Lib::new("cmd_undo");
    let done = lib.trim(&lib.job()).0.unwrap();
    let mut changed = Vec::new();
    undo_track(&lib.state, done.undo_id, Fault::NONE, &mut changed).unwrap();
    assert_eq!(changed, vec![lib.f.track_id]);
    lib.untouched();
    assert_eq!(
        lib.undo(done.undo_id).unwrap_err(),
        "unavailable: no kept backup to put back"
    );

    let again = lib.trim(&lib.job()).0.unwrap();
    let moved = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_500_000_000);
    fs::File::options()
        .write(true)
        .open(lib.f.source())
        .unwrap()
        .set_modified(moved)
        .unwrap();
    assert_eq!(lib.undo(again.undo_id).unwrap_err(), "changed");
    assert_eq!(lib.f.staged(), vec![again.backup_name]);
}

#[test]
fn an_undo_without_its_backup_is_refused_as_missing() {
    let lib = Lib::new("cmd_undo_gone");
    let done = lib.trim(&lib.job()).0.unwrap();
    fs::remove_file(lib.f.root.join(&done.backup_name)).unwrap();
    assert_eq!(lib.undo(done.undo_id).unwrap_err(), "missing");
}
