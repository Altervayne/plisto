use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use rusqlite::params;

use super::*;
use crate::normalize::normalize_path_key;
use tauri::async_runtime::block_on;

// A unique throwaway directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "plisto_cmd_locate_{}_{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// A library with one root whose Old folder holds gone tracks. The folder is the last field so the
// state's database closes before it is removed.
struct Lib {
    state: AppState,
    root_id: i64,
    music: PathBuf,
    dir: TempDir,
}

impl Lib {
    fn new() -> Self {
        let dir = TempDir::new();
        let music = dir.0.join("music");
        fs::create_dir_all(music.join("New")).unwrap();
        let conn = db::open_in_memory().unwrap();
        let (root_id, _) = db::get_or_create_root(&conn, &music.to_string_lossy(), 1).unwrap();
        Self {
            state: AppState::for_test(conn, PathBuf::new()),
            root_id,
            music,
            dir,
        }
    }

    fn old(&self) -> String {
        self.music.join("Old").to_string_lossy().into_owned()
    }

    fn new_path(&self) -> String {
        self.music.join("New").to_string_lossy().into_owned()
    }

    // Indexes `name` under Old at size 3, flagged gone.
    fn gone(&self, name: &str) -> i64 {
        self.track(&self.music.join("Old").join(name), Some(40))
    }

    fn track(&self, display: &std::path::Path, gone: Option<i64>) -> i64 {
        let display = display.to_string_lossy().into_owned();
        let conn = self.state.db.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 has_embedded_cover, scanned_at, root_id, missing_at)
             VALUES (?1, ?2, 'x.mp3', 'mp3', 3, 20, 0, 30, ?3, ?4)",
            params![normalize_path_key(&display), display, self.root_id, gone],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // Writes a file under New with `len` bytes.
    fn file(&self, name: &str, len: usize) {
        fs::write(self.music.join("New").join(name), vec![b'x'; len]).unwrap();
    }

    fn preview(&self, folder: &str, new_path: &str) -> LocateFolderPreview {
        block_on(preview(&self.state, self.root_id, folder, new_path)).unwrap()
    }

    fn apply(&self, new_path: &str, points: &mut u32) -> LocateFolderOutcome {
        let outcome = block_on(apply(&self.state, self.root_id, &self.old(), new_path, || {
            *points += 1;
            true
        }));
        outcome.unwrap()
    }
}

fn refused(preview: LocateFolderPreview) -> LocateFolderRefusal {
    match preview {
        LocateFolderPreview::Refused { reason } => reason,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_roots_own_folder_is_refused_before_anything_else() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    let root = lib.music.to_string_lossy().into_owned();
    // A trailing separator or another case is still the root.
    for folder in [root.clone(), format!("{root}\\"), root.to_uppercase()] {
        assert_eq!(
            refused(lib.preview(&folder, &lib.new_path())),
            LocateFolderRefusal::RootLevel,
            "{folder}"
        );
    }
}

#[test]
fn a_folder_with_no_gone_track_is_refused() {
    let lib = Lib::new();
    lib.track(&lib.music.join("Old").join("here.mp3"), None);
    assert_eq!(
        refused(lib.preview(&lib.old(), &lib.new_path())),
        LocateFolderRefusal::NothingGone
    );
}

#[test]
fn a_new_folder_outside_every_root_is_refused() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    let elsewhere = lib.dir.0.join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    assert_eq!(
        refused(lib.preview(&lib.old(), &elsewhere.to_string_lossy())),
        LocateFolderRefusal::OutsideRoots
    );
}

#[test]
fn an_unreadable_new_folder_is_refused() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    let missing = lib.music.join("Missing").to_string_lossy().into_owned();
    assert_eq!(
        refused(lib.preview(&lib.old(), &missing)),
        LocateFolderRefusal::Unreadable
    );
}

#[test]
fn a_new_folder_holding_none_of_the_files_is_refused() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    lib.file("a.mp3", 5);
    assert_eq!(
        refused(lib.preview(&lib.old(), &lib.new_path())),
        LocateFolderRefusal::NoMatch
    );
}

#[test]
fn a_preview_counts_relinks_merges_and_stays() {
    let lib = Lib::new();
    lib.gone("relink.mp3");
    lib.gone("merge.mp3");
    lib.gone("stays.mp3");
    lib.file("relink.mp3", 3);
    lib.file("merge.mp3", 3);
    lib.file("stays.mp3", 9);
    lib.track(&lib.music.join("New").join("merge.mp3"), None);
    assert_eq!(
        lib.preview(&lib.old(), &lib.new_path()),
        LocateFolderPreview::Ready {
            target_root_id: lib.root_id,
            total: 3,
            relinked: 1,
            merged: 1,
            stays: 1,
            albums_replaced: 0,
            partial: true,
        }
    );
}

#[test]
fn an_apply_relinks_the_gone_tracks_and_clears_the_flag() {
    let lib = Lib::new();
    let ids = [lib.gone("a.mp3"), lib.gone("b.mp3")];
    lib.file("a.mp3", 3);
    lib.file("b.mp3", 3);
    let mut points = 0;
    assert_eq!(
        lib.apply(&lib.new_path(), &mut points),
        LocateFolderOutcome::Done {
            relinked: 2,
            merged: 0,
            stays: 0,
            albums_replaced: 0
        }
    );
    assert_eq!(points, 1);
    let conn = lib.state.db.lock().unwrap();
    for (id, name) in ids.iter().zip(["a.mp3", "b.mp3"]) {
        let (path, gone): (String, bool) = conn
            .query_row(
                "SELECT display_path, missing_at IS NOT NULL FROM tracks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(PathBuf::from(path), lib.music.join("New").join(name));
        assert!(!gone);
    }
}

#[test]
fn an_apply_with_nothing_found_refuses_and_takes_no_point() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    let mut points = 0;
    assert_eq!(
        lib.apply(&lib.new_path(), &mut points),
        LocateFolderOutcome::Refused {
            reason: LocateFolderRefusal::NoMatch
        }
    );
    assert_eq!(points, 0);
}

#[test]
fn a_cancelled_stat_refuses_as_cancelled() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    lib.file("a.mp3", 3);
    let targets = read_targets(&lib.state, lib.root_id, &lib.old(), &lib.new_path())
        .unwrap()
        .unwrap();
    let flag = AtomicBool::new(true);
    assert_eq!(
        stat_files(&targets, &lib.new_path(), None, Some(&flag)),
        Err(LocateFolderRefusal::Cancelled)
    );
}

#[test]
fn a_preview_that_runs_out_of_time_is_inconclusive() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    let targets = read_targets(&lib.state, lib.root_id, &lib.old(), &lib.new_path())
        .unwrap()
        .unwrap();
    assert_eq!(
        stat_files(&targets, &lib.new_path(), Some(Instant::now()), None),
        Err(LocateFolderRefusal::Inconclusive)
    );
}

#[test]
fn an_apply_while_the_scan_lock_is_held_is_busy() {
    let lib = Lib::new();
    lib.gone("a.mp3");
    lib.file("a.mp3", 3);
    let _held = acquire_scan_lock(&lib.state, Holder::User).ok().unwrap();
    let busy = acquire_scan_lock(&lib.state, Holder::User).err().unwrap();
    let mut points = 0;
    let err = block_on(apply(&lib.state, lib.root_id, &lib.old(), &lib.new_path(), || {
        points += 1;
        true
    }))
    .unwrap_err();
    assert_eq!(err, busy);
    assert_eq!(points, 0);
}

#[test]
fn the_wire_shapes_are_tagged_and_snake_case() {
    let ready = LocateFolderPreview::Ready {
        target_root_id: 2,
        total: 5,
        relinked: 3,
        merged: 1,
        stays: 1,
        albums_replaced: 0,
        partial: true,
    };
    assert_eq!(
        serde_json::to_value(&ready).unwrap(),
        serde_json::json!({
            "kind": "ready", "target_root_id": 2, "total": 5, "relinked": 3, "merged": 1,
            "stays": 1, "albums_replaced": 0, "partial": true
        })
    );
    let preview = LocateFolderPreview::Refused {
        reason: LocateFolderRefusal::OutsideRoots,
    };
    assert_eq!(
        serde_json::to_value(&preview).unwrap(),
        serde_json::json!({ "kind": "refused", "reason": { "code": "outside_roots" } })
    );
    let done = LocateFolderOutcome::Done {
        relinked: 1,
        merged: 2,
        stays: 3,
        albums_replaced: 4,
    };
    assert_eq!(
        serde_json::to_value(&done).unwrap(),
        serde_json::json!({
            "kind": "done", "relinked": 1, "merged": 2, "stays": 3, "albums_replaced": 4
        })
    );
    let failed = LocateFolderOutcome::Refused {
        reason: LocateFolderRefusal::Failed {
            message: "boom".into(),
        },
    };
    assert_eq!(
        serde_json::to_value(&failed).unwrap(),
        serde_json::json!({ "kind": "refused", "reason": { "code": "failed", "message": "boom" } })
    );
    for (reason, code) in [
        (LocateFolderRefusal::NothingGone, "nothing_gone"),
        (LocateFolderRefusal::Same, "same"),
        (LocateFolderRefusal::Overlap, "overlap"),
        (LocateFolderRefusal::NoMatch, "no_match"),
        (LocateFolderRefusal::RootLevel, "root_level"),
        (LocateFolderRefusal::Unreadable, "unreadable"),
        (LocateFolderRefusal::Inconclusive, "inconclusive"),
        (LocateFolderRefusal::Cancelled, "cancelled"),
    ] {
        assert_eq!(
            serde_json::to_value(reason).unwrap(),
            serde_json::json!({ "code": code })
        );
    }
}
