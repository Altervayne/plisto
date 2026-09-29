/*
 * Changed-only export against a destination's record: lay a general export out, pick what a run
 * writes by diffing file fingerprints against the record, preview that same diff, adopt a destination
 * as already current, and hand back the rows a run earns. Every step that reads or writes the record
 * runs under the caller's DB lock; the run itself stays DB-free and owns its planned files. Nothing
 * here ever deletes a file at a destination.
 */

// -- Library Imports --
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use rusqlite::Connection;

// -- Local Imports --
use super::derive::{folder_dest_len, AlbumTemplate, DEVICE_DEST_LEN};
use super::job::{ExportJob, WriteSet};
use super::ledger::{change_set, changed, dest_key, export_files, landed_rows, ExportFile};
use super::plan::build_export_plan;
use super::playlist::playlist_export_plan;
use super::{run_containers, write_playlist_files};
use crate::db;
use crate::dto::{ExportChangeSet, ExportConfig, ExportProgress, ExportSummary};

// A dated snapshot lands in a fresh folder each time, so it has nothing to diff against or adopt.
const SNAPSHOT_NO_RECORD: &str = "a dated device snapshot keeps no export record";

/// One general export ready to run: its laid-out job, every file it covers with its fingerprint, the
/// part this run writes, and the destination's record key.
pub struct PlannedRun {
    job: ExportJob,
    files: Vec<ExportFile>,
    write: WriteSet,
    pub dest_key: String,
}

/// Whether the config is a device export into a fresh dated snapshot folder, which keeps no record.
fn is_dated_snapshot(config: &ExportConfig) -> bool {
    config.device.is_some() && !config.device_in_place
}

/// Snapshots and lays out one general export. A device export budgets its paths against the fixed
/// device length, never its staging path, so every run lands the same names. The playlist-file shape
/// snapshots each playlist's play-order slots so its `.m3u8` renders from the same layout; a scoped
/// export carries none.
fn prepare_job(conn: &Connection, config: &ExportConfig) -> Result<ExportJob, String> {
    let plan = build_export_plan(conn, config)?;
    let mut playlists = Vec::new();
    if config.album_ids.is_none() && config.include_playlists && config.playlist_shape == "file" {
        for p in db::load_playlists(conn)
            .map_err(|e| e.to_string())?
            .playlists
        {
            playlists.push(playlist_export_plan(conn, p.id).map_err(|e| e.to_string())?);
        }
    }
    let template = AlbumTemplate::resolve(&config.folder_pattern, &config.file_pattern);
    let dest_len = if config.device.is_some() {
        DEVICE_DEST_LEN
    } else {
        folder_dest_len(Path::new(&config.destination))
    };
    Ok(ExportJob::new(
        plan,
        config.album_ids.as_deref(),
        &playlists,
        dest_len,
        &template,
    ))
}

/// Plans one run. `fresh` marks a folder destination found missing or empty: its record describes
/// nothing that is there, so it is dropped first. A changed-only run writes just the files whose
/// fingerprint differs from the record or that carry no row; any other run writes every file. A
/// dated snapshot refuses changed-only.
pub fn plan_run(
    conn: &Connection,
    config: &ExportConfig,
    fresh: bool,
) -> Result<PlannedRun, String> {
    if config.changed_only && is_dated_snapshot(config) {
        return Err(SNAPSHOT_NO_RECORD.to_string());
    }
    let job = prepare_job(conn, config)?;
    let key = dest_key(config);
    if fresh && !is_dated_snapshot(config) {
        db::clear_export_ledger(conn, &key).map_err(|e| e.to_string())?;
    }

    let files = export_files(&job);
    let write = if config.changed_only {
        let recorded = db::export_ledger(conn, &key).map_err(|e| e.to_string())?;
        changed(&files, &recorded)
    } else {
        vec![true; files.len()]
    };
    let write = job.write_set(&files, &write);
    Ok(PlannedRun {
        job,
        files,
        write,
        dest_key: key,
    })
}

/// What a changed-only run would write, from the same diff the run uses. Read-only: a destination
/// found missing or empty (`fresh`) and a dated snapshot both read as carrying no record.
pub fn preview_changes(
    conn: &Connection,
    config: &ExportConfig,
    fresh: bool,
) -> Result<ExportChangeSet, String> {
    let job = prepare_job(conn, config)?;
    let files = export_files(&job);
    let key = dest_key(config);
    let (recorded, last) = if fresh || is_dated_snapshot(config) {
        (Default::default(), None)
    } else {
        (
            db::export_ledger(conn, &key).map_err(|e| e.to_string())?,
            db::export_ledger_last(conn, &key).map_err(|e| e.to_string())?,
        )
    };
    let diff = changed(&files, &recorded);
    Ok(change_set(&job, &files, &diff, last))
}

/// Records the destination as matching the library as it is now: a row with the current fingerprint
/// for every file an export would write, without writing any file. Returns how many were recorded.
pub fn adopt_destination(
    conn: &mut Connection,
    config: &ExportConfig,
    now: i64,
) -> Result<u32, String> {
    if is_dated_snapshot(config) {
        return Err(SNAPSHOT_NO_RECORD.to_string());
    }
    let job = prepare_job(conn, config)?;
    let rows: Vec<(String, String)> = export_files(&job)
        .into_iter()
        .map(|f| (f.rel_path, f.fingerprint))
        .collect();
    db::record_export_files(conn, &dest_key(config), &rows, now).map_err(|e| e.to_string())?;
    Ok(rows.len() as u32)
}

/// Runs a planned export into `destination`: the copies first, then the playlist files once the run
/// was not cancelled, so no playlist points at copies that never landed. Returns the report and the
/// `(rel_path, fingerprint)` rows it earns, for the caller to record when the destination keeps one.
pub fn run_planned<E>(
    run: &PlannedRun,
    destination: &Path,
    covers_dir: &Path,
    cancel: &Arc<AtomicBool>,
    emit: E,
) -> (ExportSummary, Vec<(String, String)>)
where
    E: Fn(ExportProgress) + Sync,
{
    let summary = run_containers(
        &run.write.containers,
        &run.write.layout,
        destination,
        covers_dir,
        cancel,
        emit,
    );
    let summary = ExportSummary {
        unchanged: run.write.unchanged,
        ..summary
    };
    let landed = if summary.cancelled {
        Vec::new()
    } else {
        let files = run
            .write
            .playlist_files
            .iter()
            .map(|&i| &run.job.playlist_files[i]);
        write_playlist_files(files, destination)
    };
    let rows = landed_rows(&run.job, &run.files, &summary.items, &landed);
    (summary, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{DeviceTarget, ExportItem, ExportItemStatus};
    use crate::export::container_name;
    use crate::export::ledger::FileKind;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plisto_chg_{tag}_{}_{n}_{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // A minimal valid FLAC: the stream marker and a lone STREAMINFO block, enough for lofty to open
    // and rewrite.
    fn minimal_flac() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"fLaC");
        v.push(0x80);
        v.extend_from_slice(&[0x00, 0x00, 0x22]);
        v.extend_from_slice(&[0u8; 34]);
        v
    }

    // A real FLAC on disk and its track row, so a run can copy it.
    fn insert_flac(conn: &Connection, dir: &Path, name: &str, title: &str) -> i64 {
        let path = dir.join(format!("{name}.flac"));
        fs::write(&path, minimal_flac()).unwrap();
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 raw_title, raw_artist, has_embedded_cover, scanned_at)
             VALUES (?1, ?1, 'f.flac', 'flac', 10, 20, ?2, 'Raw Artist', 0, 30)",
            rusqlite::params![path.to_string_lossy(), title],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // Album A (a1, a2) by AA, album B (b1, b2), and one single, over real sources.
    struct Fixture {
        conn: Connection,
        src: TempDir,
        a1: i64,
        a2: i64,
        b1: i64,
        album_a: i64,
        album_b: i64,
    }

    const LABEL_A: &str = "Albums/AA/Rec";
    const LABEL_B: &str = "Albums/BB/Other";

    fn fixture() -> Fixture {
        fixture_named("Rec", "BB", "Other")
    }

    fn fixture_named(a_title: &str, b_artist: &str, b_title: &str) -> Fixture {
        let src = TempDir::new("src");
        let mut conn = db::open_in_memory().unwrap();
        let a1 = insert_flac(&conn, &src.path, "a1", "A One");
        let a2 = insert_flac(&conn, &src.path, "a2", "A Two");
        let b1 = insert_flac(&conn, &src.path, "b1", "B One");
        let b2 = insert_flac(&conn, &src.path, "b2", "B Two");
        let s = insert_flac(&conn, &src.path, "s", "Hit");
        let album_a = db::create_album(
            &mut conn,
            Some(a_title.into()),
            Some("AA".into()),
            None,
            None,
            None,
            &[a1, a2],
            "album",
            1,
        )
        .unwrap()
        .id;
        let album_b = db::create_album(
            &mut conn,
            Some(b_title.into()),
            Some(b_artist.into()),
            None,
            None,
            None,
            &[b1, b2],
            "album",
            1,
        )
        .unwrap()
        .id;
        db::create_single(&mut conn, s, 1).unwrap();
        Fixture {
            conn,
            src,
            a1,
            a2,
            b1,
            album_a,
            album_b,
        }
    }

    fn config(dest: &Path) -> ExportConfig {
        ExportConfig {
            destination: dest.to_string_lossy().into_owned(),
            folder_pattern: String::new(),
            file_pattern: String::new(),
            include_albums: true,
            include_singles: true,
            include_playlists: false,
            playlist_shape: String::new(),
            album_ids: None,
            device: None,
            device_in_place: false,
            changed_only: false,
        }
    }

    fn device(in_place: bool) -> ExportConfig {
        let mut cfg = config(Path::new(""));
        cfg.device = Some(DeviceTarget {
            device_name: "Phone".into(),
            display: "Phone > Music".into(),
            pidl: "00".into(),
        });
        cfg.device_in_place = in_place;
        cfg
    }

    // An imported cover row keyed by `hash`; no blob is needed to fingerprint it.
    fn cover(conn: &Connection, hash: &str) -> i64 {
        let record = crate::model::CoverRecord {
            content_hash: hash.into(),
            source_kind: "imported".into(),
            origin_path: None,
            width: 10,
            height: 10,
            byte_len: 42,
            created_at: 1,
        };
        db::upsert_cover(conn, &record).unwrap()
    }

    // The labels of the containers holding a changed file, against the destination's record.
    fn changed_labels(conn: &Connection, config: &ExportConfig) -> BTreeSet<String> {
        let job = prepare_job(conn, config).unwrap();
        let files = export_files(&job);
        let recorded = db::export_ledger(conn, &dest_key(config)).unwrap();
        files
            .iter()
            .zip(changed(&files, &recorded))
            .filter(|(_, c)| *c)
            .map(|(f, _)| match f.kind {
                FileKind::Track { container, .. } => container_name(&job.layout[container].rel_dir),
                FileKind::Playlist { .. } => f.rel_path.clone(),
            })
            .collect()
    }

    // Runs one planned export into `dest` and records what it earned, as the command does.
    fn export(conn: &mut Connection, config: &ExportConfig, dest: &Path) -> ExportSummary {
        let fresh = !crate::export::dir_non_empty(dest);
        let run = plan_run(conn, config, fresh).unwrap();
        let covers = TempDir::new("covers");
        let cancel = Arc::new(AtomicBool::new(false));
        let (summary, rows) = run_planned(&run, dest, &covers.path, &cancel, |_| {});
        db::record_export_files(conn, &run.dest_key, &rows, 100).unwrap();
        summary
    }

    // Every file under `root`, relative to it with forward slashes.
    fn listing(root: &Path) -> BTreeSet<String> {
        fn walk(dir: &Path, root: &Path, out: &mut BTreeSet<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    let rel = path.strip_prefix(root).unwrap();
                    out.insert(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        let mut out = BTreeSet::new();
        walk(root, root, &mut out);
        out
    }

    fn labels(of: &[&str]) -> BTreeSet<String> {
        of.iter().map(|l| l.to_string()).collect()
    }

    // Records the fixture as exported, applies `mutate`, and returns the containers that flipped.
    fn flips(mutate: impl FnOnce(&mut Fixture)) -> BTreeSet<String> {
        flips_after(|_| {}, mutate)
    }

    // As `flips`, with `before` applied ahead of the recorded baseline.
    fn flips_after(
        before: impl FnOnce(&mut Fixture),
        mutate: impl FnOnce(&mut Fixture),
    ) -> BTreeSet<String> {
        let mut fx = fixture();
        let cfg = config(Path::new("/out"));
        before(&mut fx);
        adopt_destination(&mut fx.conn, &cfg, 1).unwrap();
        assert!(
            changed_labels(&fx.conn, &cfg).is_empty(),
            "a fresh record is current"
        );
        mutate(&mut fx);
        changed_labels(&fx.conn, &cfg)
    }

    #[test]
    fn after_a_full_export_nothing_reads_as_changed() {
        let mut fx = fixture();
        let dest = TempDir::new("dest");
        let mut cfg = config(&dest.path);
        let full = export(&mut fx.conn, &cfg, &dest.path);
        assert_eq!(full.exported, 5);
        assert_eq!(full.unchanged, 0);

        let preview = preview_changes(&fx.conn, &cfg, false).unwrap();
        assert!(preview.has_record);
        assert_eq!(preview.last_exported_at, Some(100));
        assert_eq!((preview.files, preview.total_files), (0, 5));

        let key = dest_key(&cfg);
        let before = db::export_ledger(&fx.conn, &key).unwrap();
        cfg.changed_only = true;
        let again = export(&mut fx.conn, &cfg, &dest.path);
        assert_eq!(again.exported, 0, "a changed-only run writes nothing");
        assert_eq!((again.unchanged, again.total), (5, 0));
        assert_eq!(db::export_ledger(&fx.conn, &key).unwrap(), before);
        assert_eq!(db::export_ledger_last(&fx.conn, &key).unwrap(), Some(100));
    }

    #[test]
    fn track_edits_flip_only_their_own_container() {
        let edit = flips(|fx| {
            db::set_track_edit(
                &fx.conn,
                fx.a1,
                Some("New".into()),
                None,
                None,
                None,
                None,
                None,
            )
            .unwrap();
        });
        assert_eq!(edit, labels(&[LABEL_A]));

        let overrides = flips(|fx| {
            db::set_track_overrides(
                &fx.conn,
                fx.album_a,
                fx.a1,
                Some("New".into()),
                None,
                Some(1),
                None,
            )
            .unwrap();
        });
        assert_eq!(overrides, labels(&[LABEL_A]));

        let genres = flips(|fx| {
            let g = db::create_genre(&fx.conn, "Rock", 1).unwrap();
            db::set_track_genres(&fx.conn, fx.a2, &[g.id]).unwrap();
        });
        assert_eq!(genres, labels(&[LABEL_A]));
    }

    #[test]
    fn a_genre_rename_flips_every_carrier() {
        let renamed = flips_after(
            |fx| {
                let genre = db::create_genre(&fx.conn, "Rock", 1).unwrap().id;
                db::set_track_genres(&fx.conn, fx.a1, &[genre]).unwrap();
                db::set_track_genres(&fx.conn, fx.b1, &[genre]).unwrap();
            },
            |fx| {
                let genre = db::create_genre(&fx.conn, "Rock", 1).unwrap().id;
                db::rename_genre(&fx.conn, genre, "Hard Rock").unwrap();
            },
        );
        assert_eq!(renamed, labels(&[LABEL_A, LABEL_B]));
    }

    #[test]
    fn cover_changes_flip_their_container_and_a_folder_cover_flips_nothing() {
        let assigned = flips(|fx| {
            let c = cover(&fx.conn, "aaaa");
            db::set_track_cover(&mut fx.conn, &[fx.a1], c, 1).unwrap();
        });
        assert_eq!(assigned, labels(&[LABEL_A]));

        let removed = flips_after(
            |fx| {
                let c = cover(&fx.conn, "aaaa");
                db::set_track_cover(&mut fx.conn, &[fx.b1], c, 1).unwrap();
            },
            |fx| db::remove_track_cover(&mut fx.conn, &[fx.b1]).unwrap(),
        );
        assert_eq!(removed, labels(&[LABEL_B]));

        let keep_own = flips(|fx| {
            db::set_track_keep_own_cover(&mut fx.conn, fx.album_a, &[fx.a2], true).unwrap();
        });
        assert_eq!(keep_own, labels(&[LABEL_A]));

        let album_cover = flips(|fx| {
            let c = cover(&fx.conn, "bbbb");
            db::set_album_cover(&fx.conn, fx.album_b, c, 1).unwrap();
        });
        assert_eq!(album_cover, labels(&[LABEL_B]));

        let folder_cover = flips(|fx| {
            let c = cover(&fx.conn, "cccc");
            db::set_folder_cover(&fx.conn, &fx.src.path.to_string_lossy(), c, 1).unwrap();
        });
        assert!(
            folder_cover.is_empty(),
            "export never reads the folder-cover tier"
        );
    }

    #[test]
    fn album_fields_flip_their_container() {
        let year = flips(|fx| {
            db::set_album_fields(
                &fx.conn,
                fx.album_b,
                Some("Other".into()),
                Some("BB".into()),
                Some(1999),
                None,
                2,
            )
            .unwrap();
        });
        assert_eq!(
            year,
            labels(&[LABEL_B]),
            "the year lands in every member's tags"
        );
    }

    #[test]
    fn membership_changes_flip_their_container() {
        let added = flips(|fx| {
            let loose = insert_flac(&fx.conn, &fx.src.path, "l", "Loose");
            db::add_tracks_to_album(&mut fx.conn, fx.album_a, &[loose]).unwrap();
        });
        assert_eq!(added, labels(&[LABEL_A]));

        // Dropping the first member moves the member art the rest of the album embeds.
        let removed = flips(|fx| {
            db::remove_tracks_from_album(&mut fx.conn, fx.album_a, &[fx.a1]).unwrap();
        });
        assert_eq!(removed, labels(&[LABEL_A]));

        let reordered = flips(|fx| {
            db::set_member_placement(&mut fx.conn, fx.album_a, fx.a1, Some(2), false).unwrap();
            db::set_member_placement(&mut fx.conn, fx.album_a, fx.a2, Some(1), false).unwrap();
        });
        assert_eq!(reordered, labels(&[LABEL_A]));
    }

    #[test]
    fn source_changes_flip_their_container() {
        let size = flips(|fx| {
            fx.conn
                .execute("UPDATE tracks SET size_bytes = 11 WHERE id = ?1", [fx.b1])
                .unwrap();
        });
        assert_eq!(size, labels(&[LABEL_B]));

        let mtime = flips(|fx| {
            fx.conn
                .execute("UPDATE tracks SET mtime = 21 WHERE id = ?1", [fx.a2])
                .unwrap();
        });
        assert_eq!(mtime, labels(&[LABEL_A]));

        // Exported while missing, the track earns no row; once it returns, it has to land.
        let returned = flips_after(
            |fx| {
                fx.conn
                    .execute("UPDATE tracks SET missing_at = 5 WHERE id = ?1", [fx.a2])
                    .unwrap();
            },
            |fx| {
                fx.conn
                    .execute("UPDATE tracks SET missing_at = NULL WHERE id = ?1", [fx.a2])
                    .unwrap();
            },
        );
        assert_eq!(returned, labels(&[LABEL_A]));
    }

    #[test]
    fn a_template_change_flips_everything() {
        let mut fx = fixture();
        adopt_destination(&mut fx.conn, &config(Path::new("/out")), 1).unwrap();

        let mut cfg = config(Path::new("/out"));
        cfg.folder_pattern = "{album}".into();
        cfg.file_pattern = "{title}".into();
        let preview = preview_changes(&fx.conn, &cfg, false).unwrap();
        assert_eq!((preview.albums, preview.singles, preview.files), (2, 0, 4));
        assert_eq!(
            preview.total_files, 5,
            "a single ignores the album template"
        );
    }

    #[test]
    fn a_failed_file_earns_no_row_and_reads_as_changed_next_time() {
        let mut fx = fixture();
        let dest = TempDir::new("dest");
        let cfg = config(&dest.path);
        // The source vanished since the last scan, so its copy fails.
        fs::remove_file(fx.src.path.join("b1.flac")).unwrap();
        let summary = export(&mut fx.conn, &cfg, &dest.path);
        assert_eq!((summary.exported, summary.errors), (4, 1));

        let preview = preview_changes(&fx.conn, &cfg, false).unwrap();
        assert_eq!((preview.files, preview.albums), (1, 1));
        assert_eq!(changed_labels(&fx.conn, &cfg), labels(&[LABEL_B]));
    }

    #[test]
    fn a_cancelled_run_records_only_what_landed() {
        let fx = fixture();
        let dest = TempDir::new("dest");
        let run = plan_run(&fx.conn, &config(&dest.path), true).unwrap();
        let covers = TempDir::new("covers");

        // Cancelled before the first container: nothing lands and nothing is earned.
        let cancel = Arc::new(AtomicBool::new(true));
        let (summary, rows) = run_planned(&run, &dest.path, &covers.path, &cancel, |_| {});
        assert!(summary.cancelled);
        assert!(rows.is_empty());

        // A report where only a1 landed before the cancel earns exactly its row.
        let items: Vec<ExportItem> = run
            .write
            .containers
            .iter()
            .zip(&run.write.layout)
            .flat_map(|(c, l)| {
                c.tracks.iter().map(move |t| ExportItem {
                    track_id: t.track_id,
                    container: container_name(&l.rel_dir),
                    status: if t.track_id == fx.a1 {
                        ExportItemStatus::Exported
                    } else {
                        ExportItemStatus::Failed
                    },
                    note: None,
                })
            })
            .collect();
        let rows = landed_rows(&run.job, &run.files, &items, &[]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "Albums/AA/Rec/01 - A One.flac");
    }

    #[test]
    fn a_colliding_album_lands_in_its_suffixed_folder_and_leaves_the_other_alone() {
        // A and B share `AA/Same`; B has the higher id, so the general export suffixes it.
        let mut fx = fixture_named("Same", "AA", "Same");
        let dest = TempDir::new("dest");
        let mut cfg = config(&dest.path);

        // Scoped to B alone, onto an empty destination.
        cfg.album_ids = Some(vec![fx.album_b]);
        let scoped = export(&mut fx.conn, &cfg, &dest.path);
        assert_eq!(scoped.exported, 2);
        assert!(dest
            .path
            .join("Albums/AA/Same (2)/01 - B One.flac")
            .exists());
        assert!(
            !dest.path.join("Albums/AA/Same").exists(),
            "A's folder is never touched"
        );

        // A full export, then a changed-only run after a B edit, still writes only B's folder.
        cfg.album_ids = None;
        export(&mut fx.conn, &cfg, &dest.path);
        let a_file = dest.path.join("Albums/AA/Same/01 - A One.flac");
        fs::write(&a_file, b"marker").unwrap();
        db::set_track_edit(
            &fx.conn,
            fx.b1,
            Some("B Uno".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        cfg.changed_only = true;
        let changed_run = export(&mut fx.conn, &cfg, &dest.path);
        assert_eq!(changed_run.exported, 1);
        assert!(dest
            .path
            .join("Albums/AA/Same (2)/01 - B Uno.flac")
            .exists());
        assert_eq!(
            fs::read(&a_file).unwrap(),
            b"marker",
            "A's copy is left as it was"
        );
    }

    #[test]
    fn a_missing_or_empty_folder_resets_to_no_record() {
        let mut fx = fixture();
        let cfg = config(Path::new("/out"));
        adopt_destination(&mut fx.conn, &cfg, 1).unwrap();
        assert!(preview_changes(&fx.conn, &cfg, false).unwrap().has_record);

        let preview = preview_changes(&fx.conn, &cfg, true).unwrap();
        assert!(
            !preview.has_record,
            "a fresh folder previews as carrying no record"
        );
        assert_eq!(preview.files, preview.total_files);
        assert!(
            !db::export_ledger(&fx.conn, &dest_key(&cfg))
                .unwrap()
                .is_empty(),
            "the preview drops nothing"
        );

        plan_run(&fx.conn, &cfg, true).unwrap();
        assert!(db::export_ledger(&fx.conn, &dest_key(&cfg))
            .unwrap()
            .is_empty());
        assert!(!preview_changes(&fx.conn, &cfg, false).unwrap().has_record);
    }

    #[test]
    fn fingerprints_are_deterministic_across_plans() {
        let fx = fixture();
        let cfg = config(Path::new("/out"));
        let prints = || -> Vec<(String, String)> {
            export_files(&prepare_job(&fx.conn, &cfg).unwrap())
                .into_iter()
                .map(|f| (f.rel_path, f.fingerprint))
                .collect()
        };
        assert_eq!(prints(), prints());
    }

    #[test]
    fn adopting_writes_no_file_and_reads_as_current() {
        let mut fx = fixture();
        let dest = TempDir::new("dest");
        let cfg = config(&dest.path);
        assert_eq!(adopt_destination(&mut fx.conn, &cfg, 7).unwrap(), 5);
        assert!(listing(&dest.path).is_empty(), "adopting writes nothing");
        let preview = preview_changes(&fx.conn, &cfg, false).unwrap();
        assert_eq!((preview.has_record, preview.files), (true, 0));
        assert_eq!(preview.last_exported_at, Some(7));
    }

    #[test]
    fn a_device_layout_ignores_the_staging_path() {
        let fx = fixture();
        // A title long enough that the path budget truncates it.
        db::set_track_edit(
            &fx.conn,
            fx.a1,
            Some("x".repeat(300)),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let cfg = device(true);
        let short = TempDir::new("s");
        let long = TempDir::new(&"l".repeat(60));
        let covers = TempDir::new("covers");
        let cancel = Arc::new(AtomicBool::new(false));

        for stage in [&short.path, &long.path] {
            let run = plan_run(&fx.conn, &cfg, false).unwrap();
            run_planned(&run, stage, &covers.path, &cancel, |_| {});
        }

        let landed = listing(&short.path);
        assert_eq!(
            landed,
            listing(&long.path),
            "both staging paths land the same names"
        );
        let a1 = landed.iter().find(|p| p.contains("xxxx")).unwrap();
        assert!(a1.len() < 300, "the long title is truncated");
    }

    #[test]
    fn a_dated_snapshot_refuses_changed_only_and_adoption() {
        let mut fx = fixture();
        let mut cfg = device(false);
        cfg.changed_only = true;
        assert!(plan_run(&fx.conn, &cfg, false).is_err());
        assert!(adopt_destination(&mut fx.conn, &cfg, 1).is_err());

        // Its preview carries no record, even beside an in-place record for the same folder.
        adopt_destination(&mut fx.conn, &device(true), 1).unwrap();
        let preview = preview_changes(&fx.conn, &cfg, false).unwrap();
        assert!(!preview.has_record);
        assert_eq!(preview.files, preview.total_files);
    }
}
