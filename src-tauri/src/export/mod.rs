/*
 * The export pipeline: materialize the organized library as a clean, tagged, arted copy on disk
 * while the source stays untouched. It mirrors the scan skeleton - a snapshot taken under a brief
 * lock, a blocking worker, a throttled progress Channel, a cooperative cancel flag - but writes to
 * the filesystem instead of the DB. The worker is DB-free: it owns the plan. Containers run
 * sequentially (folder prep and cover decode once each), tracks fan out with rayon, and every file
 * lands through temp-then-rename so a cancel or crash leaves valid files, never a torn track.
 */

// -- Module Declarations --
mod derive;
pub mod device;
pub mod extract;
pub mod plan;
pub mod playlist;
mod write;

// -- Library Imports --
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rayon::prelude::*;

// -- Local Imports --
use crate::dto::{
    DestinationCheck, ExportItem, ExportItemStatus, ExportPhase, ExportProgress, ExportSummary,
};
use crate::paths::paths_overlap;
use crate::scan::progress::ProgressThrottle;
use derive::derive_layout;
use plan::{ContainerKind, CoverPlan, ExportPlan};
use write::{export_track, write_sidecars, EmbedResult, ExportError, TrackTags};

pub use derive::{safe_component, template_preview, AlbumTemplate};
pub use plan::{build_export_plan, mimic_album_plan, playlist_folder_plan};
pub use playlist::{
    playlist_cover_plan, playlist_export_plan, render_m3u, render_rich_m3u8, PlaylistExportPlan,
};
pub use write::cover_jpeg;

// The progress cadence, matched to the scan: sample faster than the emit interval so a finished
// run is noticed quickly, and let the throttle coalesce the wakeups into steady ticks.
const PROGRESS_POLL: Duration = Duration::from_millis(50);
const PROGRESS_INTERVAL_MS: u64 = 100;

// The plain-language notes surfaced on a report row. A skip or failure carries why; an exported
// track carries a caveat only when its art could not land.
const NOTE_MISSING: &str = "source file is missing";
const NOTE_MKDIR: &str = "could not create the destination folder";
const NOTE_COPY: &str = "could not copy the source file";
const NOTE_RETAG: &str = "could not write tags";
const NOTE_UNSUPPORTED: &str = "format does not support embedded art";
const NOTE_COVER_UNAVAILABLE: &str = "cover art unavailable";

/// Runs the export over `plan`, writing into `destination`, streaming throttled progress through
/// `emit`, and returning the report. The worker never touches the DB. `cancel` stops it between
/// containers and before each track; a cancelled run leaves whatever landed and reports the rest
/// unattempted. Sources and the cover store are read-only; nothing is written outside `destination`.
pub fn run_export<E>(
    plan: &ExportPlan,
    destination: &Path,
    template: &AlbumTemplate,
    covers_dir: &Path,
    cancel: &Arc<AtomicBool>,
    emit: E,
) -> ExportSummary
where
    E: Fn(ExportProgress) + Sync,
{
    let dest_len = destination.to_string_lossy().chars().count();
    let layout = derive_layout(&plan.containers, dest_len, template);

    let present: usize = plan.containers.iter().map(|c| c.tracks.len()).sum();
    let skipped: usize = plan.containers.iter().map(|c| c.skipped.len()).sum();
    let total = (present + skipped) as u32;

    let exported = AtomicUsize::new(0);
    let errors = AtomicUsize::new(0);
    let containers_written = AtomicUsize::new(0);
    let done = AtomicBool::new(false);
    let items: Mutex<Vec<ExportItem>> = Mutex::new(Vec::new());

    // The missing-source skips are known from the plan; record them before any write.
    for (container, clayout) in plan.containers.iter().zip(&layout) {
        let name = container_name(clayout.rel_dir.as_path());
        for &track_id in &container.skipped {
            record(
                &items,
                track_id,
                &name,
                ExportItemStatus::Skipped,
                Some(NOTE_MISSING),
            );
        }
    }

    std::thread::scope(|s| {
        // The progress emitter samples the counters and emits throttled Copying ticks until the
        // worker finishes, then the single terminal Done tick.
        s.spawn(|| {
            let start = Instant::now();
            let mut throttle = ProgressThrottle::new(PROGRESS_INTERVAL_MS);
            loop {
                let is_done = done.load(Ordering::Relaxed);
                let now_ms = start.elapsed().as_millis() as u64;
                if throttle.should_emit(now_ms, is_done) {
                    emit(ExportProgress {
                        phase: if is_done {
                            ExportPhase::Done
                        } else {
                            ExportPhase::Copying
                        },
                        exported: exported.load(Ordering::Relaxed) as u32,
                        total,
                        errors: errors.load(Ordering::Relaxed) as u32,
                        done: is_done,
                    });
                }
                if is_done {
                    break;
                }
                std::thread::sleep(PROGRESS_POLL);
            }
        });

        // Sequential over containers: prepare the folder and cover once, then fan the tracks out.
        for (container, clayout) in plan.containers.iter().zip(&layout) {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let name = container_name(clayout.rel_dir.as_path());
            let dir = destination.join(&clayout.rel_dir);

            if fs::create_dir_all(&dir).is_err() {
                for track in &container.tracks {
                    errors.fetch_add(1, Ordering::Relaxed);
                    record(
                        &items,
                        track.track_id,
                        &name,
                        ExportItemStatus::Failed,
                        Some(NOTE_MKDIR),
                    );
                }
                continue;
            }
            containers_written.fetch_add(1, Ordering::Relaxed);

            // Resolve, decode and re-encode the cover once; share the JPEG with the sidecar and
            // every embed. A planned-but-unavailable cover leaves a note on each track.
            let art = cover_jpeg(&container.cover, covers_dir);
            let cover_expected = !matches!(container.cover, CoverPlan::None);
            if let Some(jpeg) = &art {
                write_sidecars(&dir, jpeg);
                // Keep the exported cover.jpg/folder.jpg out of the phone's gallery: an empty
                // .nomedia in each folder that carries art tells Android's media scanner to skip it,
                // so dozens of album covers never flood the Photos grid. A folder with no cover writes
                // no image, so it needs none. A failed write is quiet - the copies still landed.
                let _ = fs::write(dir.join(".nomedia"), b"");
            }
            let cover_bytes = art.as_deref();

            container
                .tracks
                .par_iter()
                .zip(clayout.tracks.par_iter())
                .for_each(|(track, track_layout)| {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    // album_artist and year resolve per track: the track's own edit wins, else it
                    // inherits the container's value - two tiers, always defined, so an un-edited
                    // track lands exactly the container value. The album NAME is different: a track
                    // that sits in a Plisto album takes that album's name outright, so a stale
                    // per-track album edit (a former tag the file carried in) can never survive the
                    // export. A single or a loose bag owns no album, so its own resolved album rides
                    // through. The album view's "apply to tracks" pushes the other fields on demand.
                    let album = if matches!(container.kind, ContainerKind::Album) {
                        container.title.as_deref()
                    } else {
                        track.album_override.as_deref().or(container.title.as_deref())
                    };
                    let tags = TrackTags {
                        title: track.title.as_deref(),
                        artist: track.artist.as_deref(),
                        album,
                        album_artist: track
                            .album_artist_override
                            .as_deref()
                            .or(container.album_artist.as_deref()),
                        year: track.year_override.or(container.year),
                        genres: &track.genres,
                        track_no: track.track_no,
                        disc_no: track.disc_no,
                    };
                    // Cover precedence, top down: a per-track assigned cover embeds its stored blob;
                    // else a keep-own membership embeds the track's own embedded/adjacent art; else
                    // the shared container cover. Each tier decodes and re-encodes at most once here.
                    // A per-track cover whose blob is missing or unreadable, or keep-own art the
                    // track lacks, drops quietly to the next tier - never coverless where art remains.
                    let per_track = cover_jpeg(&track.own_cover, covers_dir);
                    let own_art = if per_track.is_none() && track.keep_own_cover {
                        cover_jpeg(
                            &CoverPlan::Member {
                                source: track.source.clone(),
                                has_embedded: track.has_embedded,
                            },
                            covers_dir,
                        )
                    } else {
                        None
                    };
                    let track_cover = per_track.as_deref().or(own_art.as_deref()).or(cover_bytes);
                    match export_track(
                        &track.source,
                        &dir,
                        &track_layout.filename,
                        &tags,
                        track_cover,
                    ) {
                        Ok(embed) => {
                            exported.fetch_add(1, Ordering::Relaxed);
                            let note = embed_note(embed, cover_expected);
                            record(
                                &items,
                                track_layout.track_id,
                                &name,
                                ExportItemStatus::Exported,
                                note,
                            );
                        }
                        Err(reason) => {
                            errors.fetch_add(1, Ordering::Relaxed);
                            let note = match reason {
                                ExportError::CopyFailed => NOTE_COPY,
                                ExportError::RetagFailed => NOTE_RETAG,
                            };
                            record(
                                &items,
                                track_layout.track_id,
                                &name,
                                ExportItemStatus::Failed,
                                Some(note),
                            );
                        }
                    }
                });
        }

        done.store(true, Ordering::Relaxed);
    });

    ExportSummary {
        total,
        exported: exported.load(Ordering::Relaxed) as u32,
        skipped: skipped as u32,
        errors: errors.load(Ordering::Relaxed) as u32,
        cancelled: cancel.load(Ordering::Relaxed),
        containers_written: containers_written.load(Ordering::Relaxed) as u32,
        items: items.into_inner().unwrap_or_default(),
    }
}

/// Runs the album-structured folder export of a playlist into `destination`: the same run_export the
/// library uses, over a playlist-scoped `plan` (each album and single the playlist touches, plus one
/// Unsorted bag of its loose tracks), then the playlist's own `cover.jpg`, a `.nomedia`, and a
/// bundled `.m3u8` at the root. `cover` is the playlist's own art, written once at the root; the
/// per-album covers ride inside their containers through run_export. `m3u` is the play-order slot
/// snapshot the bundled playlist lists. `template` lays out each member album's folder and filename,
/// and the bundled m3u re-derives paths from the same one so they match. A cancelled or
/// container-less run skips the three root files. Sources and the cover store are read-only; nothing
/// is written outside `destination`.
pub fn run_playlist_folder<E>(
    plan: &ExportPlan,
    m3u: &PlaylistExportPlan,
    cover: &CoverPlan,
    destination: &Path,
    covers_dir: &Path,
    template: &AlbumTemplate,
    cancel: &Arc<AtomicBool>,
    emit: E,
) -> ExportSummary
where
    E: Fn(ExportProgress) + Sync,
{
    let summary = run_export(plan, destination, template, covers_dir, cancel, emit);

    // The root files land beside the copies once at least one container was written and the run was
    // not cancelled - the same gate the bundle used, and enough to know the destination exists.
    if !summary.cancelled && summary.containers_written > 0 {
        if let Some(jpeg) = cover_jpeg(cover, covers_dir) {
            write_root_file(destination, "cover.jpg", &jpeg);
        }
        // The empty .nomedia keeps the exported cover out of gallery scanners.
        write_root_file(destination, ".nomedia", b"");
        write_bundled_m3u(plan, m3u, destination, template);
    }

    summary
}

/// Writes one file at the destination root through a temp-then-rename, so a reader never sees a
/// half-written file. A failed write is quiet - the copies still landed.
fn write_root_file(destination: &Path, name: &str, bytes: &[u8]) {
    let final_path = destination.join(name);
    let tmp = destination.join(format!(".plisto-tmp-{name}"));
    if fs::write(&tmp, bytes).is_ok() {
        let _ = fs::rename(&tmp, &final_path);
    }
}

/// Writes the bundled `.m3u8` at the destination root, listing each present slot in play order by its
/// relative exported path (`Artist/Album/file` or `Unsorted/file`), so the playlist sits beside the
/// files it names. The name is the playlist's, or `Playlist` when unset, sanitized to a safe
/// component. Staged to a temp and atomically renamed; a failed write is quiet, the copies landed.
fn write_bundled_m3u(
    plan: &ExportPlan,
    m3u: &PlaylistExportPlan,
    destination: &Path,
    template: &AlbumTemplate,
) {
    let dest_len = destination.to_string_lossy().chars().count();
    let content = bundled_m3u_content(plan, m3u, dest_len, template);

    let stem = safe_component(m3u.name.as_deref().unwrap_or("Playlist"), "Playlist");
    write_root_file(destination, &format!("{stem}.m3u8"), content.as_bytes());
}

/// The bundled playlist body: each present slot mapped to its track's relative exported path, in play
/// order. The path map is re-derived from the same layout run_export wrote - pure and deterministic,
/// so it matches byte-for-byte - and keyed by track id, so a slot the playlist holds twice points at
/// the one copy. A missing-source slot is dropped by render_m3u, matching the copy's skip.
fn bundled_m3u_content(
    plan: &ExportPlan,
    m3u: &PlaylistExportPlan,
    dest_len: usize,
    template: &AlbumTemplate,
) -> String {
    let layout = derive_layout(&plan.containers, dest_len, template);
    let mut rel: HashMap<i64, String> = HashMap::new();
    for clayout in &layout {
        for track in &clayout.tracks {
            let path = clayout.rel_dir.join(&track.filename);
            rel.insert(track.track_id, path.to_string_lossy().replace('\\', "/"));
        }
    }
    render_m3u(m3u, |t| rel.get(&t.track_id).cloned().unwrap_or_default())
}

/// Writes one portable `.m3u8` per playlist into the general export's `Playlists/` folder, each
/// pointing at the copies the run already landed rather than duplicating them: a member or single at
/// its `Albums/`/`Singles/` path is reached with a `../` out of `Playlists/`, while a bagged orphan
/// living under the playlist's own folder is reached without. The path map is the same derivation
/// run_export wrote, keyed by track id, so a slot the playlist holds twice names the one copy and a
/// missing-source slot drops out. The files sit beside the copies, so the whole export travels as one
/// portable bundle. Called after the copies, off the cancel path; a failed write is quiet.
pub fn write_general_playlist_m3us(
    plan: &ExportPlan,
    playlists: &[PlaylistExportPlan],
    destination: &Path,
    template: &AlbumTemplate,
) {
    if playlists.is_empty() {
        return;
    }

    // The track -> root-relative exported path map, re-derived from the same layout run_export wrote.
    let dest_len = destination.to_string_lossy().chars().count();
    let layout = derive_layout(&plan.containers, dest_len, template);
    let mut rel: HashMap<i64, String> = HashMap::new();
    for clayout in &layout {
        for track in &clayout.tracks {
            let path = clayout.rel_dir.join(&track.filename);
            rel.insert(track.track_id, path.to_string_lossy().replace('\\', "/"));
        }
    }

    // A fully-referenced playlist bags nothing, so `Playlists/` may not exist yet; make it once.
    let playlists_dir = destination.join(derive::PLAYLISTS_ROOT);
    if fs::create_dir_all(&playlists_dir).is_err() {
        return;
    }
    let inside_prefix = format!("{}/", derive::PLAYLISTS_ROOT);

    for pl in playlists {
        // Each slot's path is relative to `Playlists/`: a bagged orphan already sits under it, so its
        // prefix is stripped; every other copy is one level up, reached with `../`. render_m3u drops a
        // missing-source slot, and a slot with no mapped copy renders no path.
        let content = render_m3u(pl, |t| match rel.get(&t.track_id) {
            Some(path) => match path.strip_prefix(&inside_prefix) {
                Some(inside) => inside.to_string(),
                None => format!("../{path}"),
            },
            None => String::new(),
        });
        let stem = safe_component(pl.name.as_deref().unwrap_or("Playlist"), "Playlist");
        write_root_file(&playlists_dir, &format!("{stem}.m3u8"), content.as_bytes());
    }
}

/// The note for an exported track: none when its art embedded, a caveat when the format could not
/// carry it, or when a planned cover could not be resolved. A track with no planned art is clean.
fn embed_note(embed: EmbedResult, cover_expected: bool) -> Option<&'static str> {
    match embed {
        EmbedResult::Embedded => None,
        EmbedResult::Unsupported => Some(NOTE_UNSUPPORTED),
        EmbedResult::NoArt if cover_expected => Some(NOTE_COVER_UNAVAILABLE),
        EmbedResult::NoArt => None,
    }
}

/// Pushes one report row under the shared lock. Low contention against the per-track file I/O.
fn record(
    items: &Mutex<Vec<ExportItem>>,
    track_id: i64,
    container: &str,
    status: ExportItemStatus,
    note: Option<&str>,
) {
    if let Ok(mut guard) = items.lock() {
        guard.push(ExportItem {
            track_id,
            container: container.to_string(),
            status,
            note: note.map(str::to_string),
        });
    }
}

/// A container's relative path as the label the report shows, with forward slashes for display.
fn container_name(rel_dir: &Path) -> String {
    rel_dir.to_string_lossy().replace('\\', "/")
}

// ---- Destination validation ----

/// Inspects a picked destination up front so the UI can gate and warn before a run. Refuses a
/// destination that overlaps any library root (both directions), reports whether it already holds
/// files, and proves a probe write. Never probes inside a root, so a refused destination is only
/// read.
pub fn check_destination(destination: &str, roots: &[String]) -> DestinationCheck {
    let dest = Path::new(destination);
    let inside = roots
        .iter()
        .any(|root| paths_overlap(dest, Path::new(root)));

    if inside {
        return DestinationCheck {
            ok: false,
            inside_workspace: true,
            non_empty: dir_non_empty(dest),
            writable: false,
        };
    }

    let non_empty = dir_non_empty(dest);
    let writable = probe_writable(dest);
    DestinationCheck {
        ok: writable,
        inside_workspace: false,
        non_empty,
        writable,
    }
}

/// Whether a directory exists and holds at least one entry. A missing directory reads as empty.
fn dir_non_empty(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// Creates the destination if needed and proves it is writable with a probe file that is removed
/// afterward. False when the directory cannot be created or written.
fn probe_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".plisto-write-probe");
    if fs::write(&probe, b"plisto").is_err() {
        return false;
    }
    let _ = fs::remove_file(&probe);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use lofty::prelude::{ItemKey, TaggedFileExt};
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicU32;

    // One album ExportTrack for the bundled-path test.
    fn album_track(track_id: i64, title: &str, artist: &str, track_no: Option<i64>) -> plan::ExportTrack {
        plan::ExportTrack {
            track_id,
            source: format!("/m/{track_id}.mp3"),
            ext: "mp3".into(),
            title: Some(title.into()),
            artist: Some(artist.into()),
            album_override: None,
            album_artist_override: None,
            year_override: None,
            genres: Vec::new(),
            track_no,
            disc_no: None,
            has_embedded: false,
            keep_own_cover: false,
            own_cover: CoverPlan::None,
        }
    }

    // One play-order slot, carrying only what render_m3u reads for its label and duration.
    fn slot(track_id: i64, artist: &str, title: &str) -> playlist::PlaylistExportTrack {
        playlist::PlaylistExportTrack {
            track_id,
            source_path: format!("/m/{track_id}.mp3"),
            duration_secs: Some(10.0),
            missing_at: None,
            title: Some(title.into()),
            artist: Some(artist.into()),
        }
    }

    #[test]
    fn bundled_m3u_references_relative_exported_paths() {
        // An album member and a loose track: the bundle points each slot at its container-relative
        // path - Artist/Album for the member, Unsorted for the loose one - in play order.
        let album = plan::ExportContainer {
            album_id: 1,
            kind: plan::ContainerKind::Album,
            bucket: plan::Bucket::Root,
            flat: false,
            album_artist: Some("AA".into()),
            title: Some("Rec".into()),
            year: None,
            cover: CoverPlan::None,
            tracks: vec![album_track(10, "Song", "Art", Some(1))],
            skipped: Vec::new(),
        };
        let unsorted = plan::ExportContainer {
            album_id: 0,
            kind: plan::ContainerKind::Unsorted,
            bucket: plan::Bucket::Root,
            flat: false,
            album_artist: None,
            title: None,
            year: None,
            cover: CoverPlan::None,
            tracks: vec![album_track(20, "Loose", "Solo", None)],
            skipped: Vec::new(),
        };
        let export_plan = ExportPlan {
            containers: vec![album, unsorted],
        };
        let m3u = PlaylistExportPlan {
            name: Some("Mix".into()),
            tracks: vec![slot(10, "Art", "Song"), slot(20, "Solo", "Loose")],
        };

        let content = bundled_m3u_content(&export_plan, &m3u, 0, &AlbumTemplate::resolve("", ""));
        assert_eq!(
            content,
            "#EXTM3U\n\
             #EXTINF:10,Art - Song\n\
             AA/Rec/01 - Song.mp3\n\
             #EXTINF:10,Solo - Loose\n\
             Unsorted/Solo - Loose.mp3\n",
            "each slot points at its relative exported path in play order",
        );
    }

    #[test]
    fn general_playlist_m3u_references_copies_relative_to_the_playlists_folder() {
        let dest = TempDir::new("dest");

        // An album copied under Albums/, and an orphan bagged under the playlist's own folder.
        let album = plan::ExportContainer {
            album_id: 1,
            kind: plan::ContainerKind::Album,
            bucket: plan::Bucket::Albums,
            flat: false,
            album_artist: Some("AA".into()),
            title: Some("Rec".into()),
            year: None,
            cover: CoverPlan::None,
            tracks: vec![album_track(10, "Song", "Art", Some(1))],
            skipped: Vec::new(),
        };
        let bag = plan::ExportContainer {
            album_id: 0,
            kind: plan::ContainerKind::Unsorted,
            bucket: plan::Bucket::Playlist("Mix".into()),
            flat: false,
            album_artist: None,
            title: None,
            year: None,
            cover: CoverPlan::None,
            tracks: vec![album_track(20, "Loose", "Solo", None)],
            skipped: Vec::new(),
        };
        let export_plan = ExportPlan {
            containers: vec![album, bag],
        };
        let pl = PlaylistExportPlan {
            name: Some("Mix".into()),
            tracks: vec![slot(10, "Art", "Song"), slot(20, "Solo", "Loose")],
        };

        write_general_playlist_m3us(
            &export_plan,
            &[pl],
            dest.path.as_path(),
            &AlbumTemplate::resolve("", ""),
        );

        let content =
            fs::read_to_string(dest.path.join("Playlists").join("Mix.m3u8")).unwrap();
        assert!(
            content.contains("\n../Albums/AA/Rec/01 - Song.mp3\n"),
            "a covered member is reached with ../ out of Playlists/; got:\n{content}",
        );
        assert!(
            content.contains("\nMix/Unsorted/Solo - Loose.mp3\n"),
            "a bagged orphan is reached from within Playlists/; got:\n{content}",
        );
    }

    #[test]
    fn check_destination_refuses_inside_any_root() {
        let roots = vec!["/music/one".to_string(), "/music/two".to_string()];

        // A dest inside the second root is refused and returns before any disk probe.
        let inside = check_destination("/music/two/export", &roots);
        assert!(inside.inside_workspace, "a dest inside a root is refused");
        assert!(!inside.ok);
        assert!(!inside.writable);
    }

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
                "plisto_exp_{tag}_{}_{n}_{nanos}",
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
    // and rewrite. No audio frames are needed to parse.
    fn minimal_flac() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"fLaC");
        v.push(0x80);
        v.extend_from_slice(&[0x00, 0x00, 0x22]);
        v.extend_from_slice(&[0u8; 34]);
        v
    }

    // Inserts a track row whose display_path is a real FLAC on disk, so the worker can copy it.
    fn insert_flac_track(conn: &Connection, path: &str, title: &str) -> i64 {
        conn.execute(
            "INSERT INTO tracks (source_path, display_path, filename, ext, size_bytes, mtime,
                                 raw_title, raw_artist, has_embedded_cover, scanned_at)
             VALUES (?1, ?1, 'f.flac', 'flac', 10, 20, ?2, 'Raw Artist', 0, 30)",
            rusqlite::params![path, title],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    // The AlbumArtist tag of an exported file, or None when it carries none.
    fn read_album_artist(path: &Path) -> Option<String> {
        let tagged = lofty::read_from_path(path).unwrap();
        tagged
            .primary_tag()
            .and_then(|t| t.get_string(ItemKey::AlbumArtist).map(str::to_string))
    }

    #[test]
    fn album_artist_override_wins_while_a_sibling_inherits_the_album() {
        let sources = TempDir::new("src");
        let dest = TempDir::new("dest");
        let covers = TempDir::new("covers");

        let a_path = sources.path.join("a.flac");
        let b_path = sources.path.join("b.flac");
        fs::write(&a_path, minimal_flac()).unwrap();
        fs::write(&b_path, minimal_flac()).unwrap();

        let mut conn = db::open_in_memory().unwrap();
        let a = insert_flac_track(&conn, &a_path.to_string_lossy(), "T1");
        let b = insert_flac_track(&conn, &b_path.to_string_lossy(), "T2");
        db::create_album(
            &mut conn,
            Some("Rec".into()),
            Some("Album AA".into()),
            None,
            None,
            None,
            &[a, b],
            "album",
            1,
        )
        .unwrap();

        // Only the first member carries an album_artist edit; the second stays pristine.
        db::set_track_edit(
            &conn,
            a,
            None,
            None,
            None,
            Some("Solo AA".into()),
            None,
            None,
        )
        .unwrap();

        let plan = plan::build_plan(&conn).unwrap();
        let template = AlbumTemplate::resolve("", "");
        let cancel = Arc::new(AtomicBool::new(false));
        let summary = run_export(
            &plan,
            dest.path.as_path(),
            &template,
            covers.path.as_path(),
            &cancel,
            |_| {},
        );
        assert_eq!(summary.exported, 2);

        // The folder still keys off the container's album artist, not the per-track override.
        let container = dest.path.join("Album AA").join("Rec");
        assert_eq!(
            read_album_artist(&container.join("01 - T1.flac")).as_deref(),
            Some("Solo AA"),
            "the edited track exports its own album_artist",
        );
        assert_eq!(
            read_album_artist(&container.join("02 - T2.flac")).as_deref(),
            Some("Album AA"),
            "the untouched sibling inherits the album's album_artist",
        );
    }

    // The Album (name) tag of an exported file, or None when it carries none.
    fn read_album(path: &Path) -> Option<String> {
        let tagged = lofty::read_from_path(path).unwrap();
        tagged
            .primary_tag()
            .and_then(|t| t.get_string(ItemKey::AlbumTitle).map(str::to_string))
    }

    #[test]
    fn an_album_members_name_is_the_albums_not_a_stale_track_edit() {
        let sources = TempDir::new("src");
        let dest = TempDir::new("dest");
        let covers = TempDir::new("covers");
        let a_path = sources.path.join("a.flac");
        fs::write(&a_path, minimal_flac()).unwrap();

        let mut conn = db::open_in_memory().unwrap();
        let a = insert_flac_track(&conn, &a_path.to_string_lossy(), "T1");
        db::create_album(&mut conn, Some("Real Album".into()), Some("AA".into()), None, None, None, &[a], "album", 1).unwrap();
        // A stale per-track album edit - a former tag the file carried in - must not survive the export.
        db::set_track_edit(&conn, a, None, None, Some("Stale Album".into()), None, None, None).unwrap();

        let plan = plan::build_plan(&conn).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        run_export(
            &plan,
            dest.path.as_path(),
            &AlbumTemplate::resolve("", ""),
            covers.path.as_path(),
            &cancel,
            |_| {},
        );

        let out = dest.path.join("AA").join("Real Album").join("01 - T1.flac");
        assert_eq!(
            read_album(&out).as_deref(),
            Some("Real Album"),
            "the album's own name wins over a stale per-track album edit",
        );
    }

    // A tiny decodable JPEG for a stored cover, so run_export resolves real art and writes sidecars.
    fn jpeg_blob() -> Vec<u8> {
        use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
        use std::io::Cursor;
        let img = RgbImage::from_pixel(8, 8, Rgb([180, 60, 20]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Jpeg)
            .unwrap();
        buf.into_inner()
    }

    // A bare album ExportTrack over a real source path, for the run_export integration tests that
    // build their plan by hand rather than through build_plan.
    fn source_track(track_id: i64, source: &Path, title: &str) -> plan::ExportTrack {
        plan::ExportTrack {
            track_id,
            source: source.to_string_lossy().into_owned(),
            ext: "flac".into(),
            title: Some(title.into()),
            artist: Some("Artist".into()),
            album_override: None,
            album_artist_override: None,
            year_override: None,
            genres: Vec::new(),
            track_no: Some(1),
            disc_no: None,
            has_embedded: false,
            keep_own_cover: false,
            own_cover: CoverPlan::None,
        }
    }

    #[test]
    fn run_export_drops_a_nomedia_beside_an_exported_cover_and_nowhere_else() {
        let sources = TempDir::new("src");
        let dest = TempDir::new("dest");
        let covers = TempDir::new("covers");

        // A real source to copy, and a decodable cover blob in the store keyed by its own hash.
        let a_path = sources.path.join("a.flac");
        fs::write(&a_path, minimal_flac()).unwrap();
        let blob = jpeg_blob();
        let hash = blake3::hash(&blob).to_hex().to_string();
        fs::write(
            crate::covers::full_res_cache_path(covers.path.as_path(), &hash),
            &blob,
        )
        .unwrap();

        // One album carries a cover; a second has none, to prove a coverless folder stays clean.
        let covered = plan::ExportContainer {
            album_id: 1,
            kind: plan::ContainerKind::Album,
            bucket: plan::Bucket::Root,
            flat: false,
            album_artist: Some("Artist".into()),
            title: Some("Album".into()),
            year: None,
            cover: CoverPlan::Store {
                content_hash: hash,
                byte_len: blob.len() as i64,
            },
            tracks: vec![source_track(1, &a_path, "Song")],
            skipped: Vec::new(),
        };
        let b_path = sources.path.join("b.flac");
        fs::write(&b_path, minimal_flac()).unwrap();
        let bare = plan::ExportContainer {
            album_id: 2,
            kind: plan::ContainerKind::Album,
            bucket: plan::Bucket::Root,
            flat: false,
            album_artist: Some("Artist".into()),
            title: Some("Bare Album".into()),
            year: None,
            cover: CoverPlan::None,
            tracks: vec![source_track(2, &b_path, "Bare")],
            skipped: Vec::new(),
        };

        let plan = ExportPlan {
            containers: vec![covered, bare],
        };
        let cancel = Arc::new(AtomicBool::new(false));
        run_export(
            &plan,
            dest.path.as_path(),
            &AlbumTemplate::resolve("", ""),
            covers.path.as_path(),
            &cancel,
            |_| {},
        );

        let with_cover = dest.path.join("Artist").join("Album");
        assert!(with_cover.join("cover.jpg").exists(), "the cover sidecar landed");
        assert!(
            with_cover.join(".nomedia").exists(),
            "a .nomedia sits beside the exported cover so the gallery skips it",
        );

        let without = dest.path.join("Artist").join("Bare Album");
        assert!(
            !without.join(".nomedia").exists(),
            "a coverless folder writes no image, so it gets no .nomedia",
        );
    }
}
