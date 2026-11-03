/*
 * The IPC commands that point a root at the folder its files moved to. A preview checks the picked
 * folder (a bounded stat sample for a move, an exact database match for a merge into a root already
 * in the library) and a relocate repeats that check under the scan lock, backs the database up, runs
 * the writer and rescans. A refusal before the commit comes back as a value and changes nothing;
 * only a scan failure after the commit is an error. The database mutex is only held for reads and
 * for the backup and writer, never across the stat sample or an await.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Instant;

use rusqlite::Connection;
use tauri::ipc::Channel;
use tauri::State;

// -- Local Imports --
use super::roots::run_scan_blocking;
use crate::db::{self, RootTrackPath};
use crate::dto::{
    RelinkCandidate, RelocateOutcome, RelocatePreview, RelocateRefusal, Root, ScanProgress,
};
use crate::library_sync::SyncCmd;
use crate::relocate::{
    check_sample, classify_target, pick_sample, rank_candidates, verdict, SampleResult, Target,
    Verdict, VERIFY_DEADLINE,
};
use crate::scan::{self, ScanRoot};
use crate::scan_lock::{acquire_scan_lock, Holder};
use crate::state::AppState;

const BACKUP_FILE: &str = "plisto.relocate-backup.sqlite";

const INDEX_UNAVAILABLE: &str = "index is unavailable";

/// What the database read settled: a finished answer, or a move that still needs its stat sample.
enum Staged {
    Answer(RelocatePreview),
    Verify {
        total: i64,
        rows: Vec<RootTrackPath>,
        old_path: String,
    },
}

/// The roots that may have moved and look like `path`: offline ones and ones whose every track is
/// gone, best match first. Empty when `path` cannot be read or holds nothing alike. Takes no lock.
#[tauri::command]
pub async fn relink_candidates(
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<RelinkCandidate>, String> {
    let roots = {
        let conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
        db::list_roots(&conn).map_err(|e| e.to_string())?
    };
    let all: Vec<(i64, String)> = roots.iter().map(|r| (r.id, r.path.clone())).collect();

    // Reachability is a filesystem call, so it runs off the runtime.
    let eligible = tauri::async_runtime::spawn_blocking(move || -> Vec<Root> {
        roots
            .into_iter()
            .filter(|r| r.track_count > 0)
            .filter(|r| {
                r.missing_count == r.track_count || !scan::root_reachable(Path::new(&r.path))
            })
            .collect()
    })
    .await
    .map_err(|_| "relink check failed to run".to_string())?;
    if eligible.is_empty() {
        return Ok(Vec::new());
    }

    let loaded = {
        let conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
        eligible
            .into_iter()
            .map(|root| db::root_track_paths(&conn, root.id).map(|rows| (root, rows)))
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let new_root = PathBuf::from(path);
        if !scan::root_reachable(&new_root) {
            return Vec::new();
        }
        rank_candidates(&new_root, loaded, &all, Instant::now() + VERIFY_DEADLINE)
    })
    .await
    .map_err(|_| "relink check failed to run".to_string())
}

/// What relocating `root_id` to `new_path` would do, without changing anything. Takes no lock: a
/// move is checked by a bounded stat sample, a merge by an exact match of the two roots' rows.
#[tauri::command]
pub async fn preview_relocate(
    root_id: i64,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<RelocatePreview, String> {
    assess(&state, root_id, &new_path).await
}

/// Points `root_id` at `new_path`, or folds it with the root already there, then rescans it,
/// streaming progress over `on_progress`. The scan lock is held from the re-check through the
/// rescan, and the preview is never trusted. A refusal, including a failed backup or writer (which
/// leave the library as it was), is returned as `Refused`. Only a scan failure after the commit is an
/// error.
#[tauri::command]
pub async fn relocate_root(
    root_id: i64,
    new_path: String,
    on_progress: Channel<ScanProgress>,
    state: State<'_, AppState>,
) -> Result<RelocateOutcome, String> {
    let _lock = acquire_scan_lock(&state, Holder::User)?;
    state.cancel.store(false, Ordering::SeqCst);

    let merge_with = match assess(&state, root_id, &new_path).await? {
        RelocatePreview::Refused { reason } => return Ok(RelocateOutcome::Refused { reason }),
        RelocatePreview::Move { .. } => None,
        RelocatePreview::Merge { other_id, .. } => Some(other_id),
    };

    let scanned_at = super::now_unix();
    let written = {
        let mut conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
        let backup = state.db_path.with_file_name(BACKUP_FILE);
        write_relocation(
            &mut conn, &backup, root_id, &new_path, merge_with, scanned_at,
        )
    };
    let report = match written {
        Ok(report) => report,
        Err(message) => {
            return Ok(RelocateOutcome::Refused {
                reason: RelocateRefusal::Failed { message },
            })
        }
    };
    let _ = state.library_sync.send(SyncCmd::RootsChanged);

    // A merge leaves the kept root at the other root's stored path, which may differ in case from
    // the picked one, so the rescan reads the path back.
    let target = {
        let conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
        db::root_target(&conn, root_id).map_err(|e| e.to_string())?
    };
    let Some((id, path)) = target else {
        return Err("no such folder".to_string());
    };
    let root = ScanRoot {
        id,
        path: PathBuf::from(path),
        units: None,
    };
    let summary = run_scan_blocking(&state, vec![root], scanned_at, on_progress).await?;
    Ok(RelocateOutcome::Done {
        summary,
        merged: merge_with.is_some(),
        albums_replaced: report.albums_emptied,
    })
}

/// Checks `new_path` for `root_id`: the database read under a brief lock, then the stat sample on a
/// blocking thread with no lock held.
async fn assess(state: &AppState, root_id: i64, new_path: &str) -> Result<RelocatePreview, String> {
    let staged = {
        let conn = state.db.lock().map_err(|_| INDEX_UNAVAILABLE.to_string())?;
        stage(&conn, root_id, new_path)
    };
    let (total, rows, old_path) = match staged {
        Staged::Answer(preview) => return Ok(preview),
        Staged::Verify {
            total,
            rows,
            old_path,
        } => (total, rows, old_path),
    };
    let new_root = PathBuf::from(new_path);
    let checked = tauri::async_runtime::spawn_blocking(move || {
        verify_move(&rows, Path::new(&old_path), &new_root)
    })
    .await
    .map_err(|_| "relocate check failed to run".to_string())?;
    Ok(judge_move(total, checked))
}

/// The database half of the check: where `new_path` stands against the roots, and for a merge the
/// whole answer.
fn stage(conn: &Connection, root_id: i64, new_path: &str) -> Staged {
    match read_stage(conn, root_id, new_path) {
        Ok(staged) => staged,
        Err(message) => refused(RelocateRefusal::Failed { message }),
    }
}

fn read_stage(conn: &Connection, root_id: i64, new_path: &str) -> Result<Staged, String> {
    let roots = db::root_targets(conn).map_err(|e| e.to_string())?;
    let Some((_, old_path)) = roots.iter().find(|(id, _)| *id == root_id).cloned() else {
        return Err("no such folder".to_string());
    };
    Ok(
        match classify_target((root_id, &old_path), &roots, new_path) {
            Target::Same => refused(RelocateRefusal::Same),
            Target::Overlap { other } => refused(RelocateRefusal::Overlap { other }),
            Target::Merge { other_id } => Staged::Answer(merge_preview(conn, root_id, other_id)?),
            Target::CaseOnly | Target::Fresh => {
                let rows = db::root_track_paths(conn, root_id).map_err(|e| e.to_string())?;
                Staged::Verify {
                    total: rows.len() as i64,
                    rows,
                    old_path,
                }
            }
        },
    )
}

fn refused(reason: RelocateRefusal) -> Staged {
    Staged::Answer(RelocatePreview::Refused { reason })
}

/// A merge of `other_id` into `root_id`, counted exactly from the two roots' rows. The same
/// thresholds apply as for a sample, over the kept root's tracks.
fn merge_preview(
    conn: &Connection,
    root_id: i64,
    other_id: i64,
) -> Result<RelocatePreview, String> {
    let plan = db::plan_merge(conn, root_id, other_id).map_err(|e| e.to_string())?;
    let matched = plan.pairs.len() as i64;
    let total = matched + plan.keep_only.len() as i64;
    let count = |n: i64| u32::try_from(n).unwrap_or(u32::MAX);
    let partial = match verdict(count(total), count(matched), false) {
        Verdict::Accept => false,
        Verdict::Partial => true,
        Verdict::NoMatch | Verdict::Inconclusive => {
            return Ok(RelocatePreview::Refused {
                reason: RelocateRefusal::NoMatch {
                    sampled: count(total),
                    matched: count(matched),
                },
            })
        }
    };
    Ok(RelocatePreview::Merge {
        other_id,
        other_tracks: matched + plan.absorb_only.len() as i64,
        total,
        matched,
        albums_replaced: plan.albums_emptied,
        partial,
    })
}

/// The filesystem half of a move check; None when the new folder cannot be read.
fn verify_move(rows: &[RootTrackPath], old_root: &Path, new_root: &Path) -> Option<SampleResult> {
    if !scan::root_reachable(new_root) {
        return None;
    }
    let sample = pick_sample(rows, old_root);
    Some(check_sample(
        &sample,
        new_root,
        Instant::now() + VERIFY_DEADLINE,
    ))
}

fn judge_move(total: i64, checked: Option<SampleResult>) -> RelocatePreview {
    let Some(found) = checked else {
        return RelocatePreview::Refused {
            reason: RelocateRefusal::Unreadable,
        };
    };
    let read = verdict(found.sampled, found.matched, found.timed_out);
    let reason = match read {
        Verdict::Accept | Verdict::Partial => {
            return RelocatePreview::Move {
                total,
                sampled: found.sampled,
                matched: found.matched,
                partial: read == Verdict::Partial,
            }
        }
        Verdict::NoMatch => RelocateRefusal::NoMatch {
            sampled: found.sampled,
            matched: found.matched,
        },
        Verdict::Inconclusive => RelocateRefusal::Inconclusive,
    };
    RelocatePreview::Refused { reason }
}

/// Backs the database up to `backup`, then runs the move or the merge. An error is the message to
/// show; the library is unchanged in every error case.
fn write_relocation(
    conn: &mut Connection,
    backup: &Path,
    root_id: i64,
    new_path: &str,
    merge_with: Option<i64>,
    now: i64,
) -> Result<db::RelocateReport, String> {
    db::backup_to(conn, backup).map_err(|e| e.to_string())?;
    match merge_with {
        Some(other_id) => db::merge_root(conn, root_id, other_id, now),
        None => db::move_root(conn, root_id, new_path),
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::normalize_path_key;
    use rusqlite::params;

    const OLD: &str = "/Music/Old";
    const NEW: &str = "/Volumes/Disk/Music";

    fn add_root(conn: &Connection, path: &str) -> i64 {
        db::insert_root(conn, &normalize_path_key(path), path, 1).unwrap()
    }

    fn add_track(conn: &Connection, root_id: i64, root: &str, file: &str) {
        let display = PathBuf::from(root)
            .join(file)
            .to_string_lossy()
            .into_owned();
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 has_embedded_cover, scanned_at, root_id)
             VALUES (?1, ?2, ?3, 'mp3', 3, 20, 0, 30, ?4)",
            params![normalize_path_key(&display), display, file, root_id],
        )
        .unwrap();
    }

    fn library() -> (Connection, i64) {
        let conn = db::open_in_memory().unwrap();
        let old = add_root(&conn, OLD);
        (conn, old)
    }

    fn answer(staged: Staged) -> RelocatePreview {
        match staged {
            Staged::Answer(preview) => preview,
            Staged::Verify { .. } => panic!("expected a finished answer"),
        }
    }

    fn refusal(preview: RelocatePreview) -> RelocateRefusal {
        match preview {
            RelocatePreview::Refused { reason } => reason,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn staging_the_same_folder_is_refused_as_same() {
        let (conn, old) = library();
        let reason = refusal(answer(stage(&conn, old, OLD)));
        assert_eq!(reason, RelocateRefusal::Same);
    }

    #[test]
    fn staging_a_folder_inside_another_root_is_refused_as_overlap() {
        let (conn, old) = library();
        add_root(&conn, NEW);
        let inside = format!("{NEW}/Sub");
        let reason = refusal(answer(stage(&conn, old, &inside)));
        assert_eq!(
            reason,
            RelocateRefusal::Overlap {
                other: NEW.to_string()
            }
        );
    }

    #[test]
    fn staging_a_missing_root_fails_without_writing() {
        let (conn, _) = library();
        let reason = refusal(answer(stage(&conn, 999, NEW)));
        assert!(matches!(reason, RelocateRefusal::Failed { .. }));
    }

    #[test]
    fn staging_a_fresh_folder_hands_over_the_rows_to_verify() {
        let (conn, old) = library();
        add_track(&conn, old, OLD, "a.mp3");
        add_track(&conn, old, OLD, "b.mp3");
        match stage(&conn, old, NEW) {
            Staged::Verify {
                total,
                rows,
                old_path,
            } => {
                assert_eq!((total, rows.len()), (2, 2));
                assert_eq!(old_path, OLD);
            }
            Staged::Answer(other) => panic!("expected a sample, got {other:?}"),
        }
    }

    #[test]
    fn staging_a_root_already_in_the_library_previews_an_exact_merge() {
        let (conn, old) = library();
        let new = add_root(&conn, NEW);
        for i in 0..10 {
            add_track(&conn, old, OLD, &format!("t{i}.mp3"));
        }
        for i in 0..6 {
            add_track(&conn, new, NEW, &format!("t{i}.mp3"));
        }
        for i in 0..2 {
            add_track(&conn, new, NEW, &format!("added{i}.mp3"));
        }
        assert_eq!(
            answer(stage(&conn, old, NEW)),
            RelocatePreview::Merge {
                other_id: new,
                other_tracks: 8,
                total: 10,
                matched: 6,
                albums_replaced: 0,
                partial: true,
            }
        );
    }

    #[test]
    fn a_merge_of_roots_that_barely_pair_is_refused() {
        let (conn, old) = library();
        let new = add_root(&conn, NEW);
        for i in 0..10 {
            add_track(&conn, old, OLD, &format!("t{i}.mp3"));
            add_track(&conn, new, NEW, &format!("other{i}.mp3"));
        }
        assert_eq!(
            refusal(answer(stage(&conn, old, NEW))),
            RelocateRefusal::NoMatch {
                sampled: 10,
                matched: 0
            }
        );
    }

    fn found(sampled: u32, matched: u32, timed_out: bool) -> Option<SampleResult> {
        Some(SampleResult {
            sampled,
            matched,
            timed_out,
        })
    }

    #[test]
    fn judging_a_move_follows_the_sample() {
        assert_eq!(
            judge_move(100, found(48, 48, false)),
            RelocatePreview::Move {
                total: 100,
                sampled: 48,
                matched: 48,
                partial: false
            }
        );
        assert_eq!(
            judge_move(100, found(48, 30, false)),
            RelocatePreview::Move {
                total: 100,
                sampled: 48,
                matched: 30,
                partial: true
            }
        );
        assert_eq!(
            refusal(judge_move(100, found(48, 5, false))),
            RelocateRefusal::NoMatch {
                sampled: 48,
                matched: 5
            }
        );
        assert_eq!(
            refusal(judge_move(100, found(4, 4, true))),
            RelocateRefusal::Inconclusive
        );
        assert_eq!(refusal(judge_move(100, None)), RelocateRefusal::Unreadable);
    }

    #[test]
    fn the_wire_shapes_are_tagged_and_snake_case() {
        let preview = RelocatePreview::Refused {
            reason: RelocateRefusal::NoMatch {
                sampled: 48,
                matched: 2,
            },
        };
        assert_eq!(
            serde_json::to_value(&preview).unwrap(),
            serde_json::json!({
                "kind": "refused",
                "reason": { "code": "no_match", "sampled": 48, "matched": 2 }
            })
        );
        let merge = RelocatePreview::Merge {
            other_id: 2,
            other_tracks: 3,
            total: 4,
            matched: 1,
            albums_replaced: 0,
            partial: true,
        };
        assert_eq!(serde_json::to_value(&merge).unwrap()["kind"], "merge");
        assert_eq!(
            serde_json::to_value(RelocateRefusal::Unreadable).unwrap(),
            serde_json::json!({ "code": "unreadable" })
        );
    }

    // A unique path under the system temp dir for a backup file.
    fn temp_backup(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("plisto_{tag}_{}.sqlite", std::process::id()))
    }

    #[test]
    fn a_relocation_backs_up_before_it_writes() {
        let (mut conn, old) = library();
        add_track(&conn, old, OLD, "a.mp3");
        let backup = temp_backup("relocate_cmd_backup");
        let report = write_relocation(&mut conn, &backup, old, NEW, None, 5).unwrap();
        assert_eq!(report.moved, 1);

        // The copy holds the library as it was before the move.
        let copy = Connection::open(&backup).unwrap();
        let path: String = copy
            .query_row("SELECT path FROM roots WHERE id = ?1", params![old], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(path, OLD);
        drop(copy);
        let _ = std::fs::remove_file(&backup);
    }

    #[test]
    fn a_failed_backup_stops_before_the_writer() {
        let (mut conn, old) = library();
        add_track(&conn, old, OLD, "a.mp3");
        let missing_dir = std::env::temp_dir()
            .join(format!("plisto_no_such_dir_{}", std::process::id()))
            .join("backup.sqlite");
        assert!(write_relocation(&mut conn, &missing_dir, old, NEW, None, 5).is_err());
        assert_eq!(db::root_target(&conn, old).unwrap().unwrap().1, OLD);
    }

    #[test]
    fn a_writer_abort_leaves_the_library_unchanged() {
        let (mut conn, old) = library();
        // A track stored outside its root cannot be rewritten.
        add_track(&conn, old, "/Elsewhere", "stray.mp3");
        let backup = temp_backup("relocate_cmd_abort");
        let err = write_relocation(&mut conn, &backup, old, NEW, None, 5).unwrap_err();
        assert!(err.contains("outside"), "message names the cause: {err}");
        assert_eq!(db::root_target(&conn, old).unwrap().unwrap().1, OLD);
        let _ = std::fs::remove_file(&backup);
    }
}
