/*
 * The export record's pure half: every file a laid-out export covers, each with a fingerprint of all
 * that shapes its bytes at the destination, and the diff of those fingerprints against what a
 * destination recorded. No disk and no DB: a fingerprint reads the plan alone, never the file, so a
 * preview stays cheap and a run computes the exact same values. Every input is hashed in a fixed
 * order with its length, so equal inputs always give equal fingerprints.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};

// -- Local Imports --
use super::job::ExportJob;
use super::plan::{Bucket, ContainerKind, CoverPlan, ExportContainer, ExportTrack};
use super::{container_name, track_tags};
use crate::dto::{ExportChangeSet, ExportConfig, ExportItem, ExportItemStatus};
use crate::normalize::normalize_path_key;

// Bumped whenever the fingerprint inputs or the way the writer turns them into bytes change, so every
// recorded file reads as changed and lands again.
const LEDGER_VERSION: u32 = 1;

// The markers that keep one kind of hashed input from ever reading as another.
const TRACK_FILE: &[u8] = b"track";
const PLAYLIST_FILE: &[u8] = b"playlist";
const COVER_STORE: &[u8] = b"store";
const COVER_MEMBER: &[u8] = b"member";
const COVER_NONE: &[u8] = b"none";

/// One file an export covers: its path relative to the destination (forward slashes), its
/// fingerprint, and where it comes from in the job.
#[derive(Debug, Clone)]
pub struct ExportFile {
    pub rel_path: String,
    pub fingerprint: String,
    pub kind: FileKind,
}

/// Where an export file comes from: a track copy, by its container and track index in the job's plan,
/// or a portable playlist file, by its index in the job's playlist files.
#[derive(Debug, Clone, Copy)]
pub enum FileKind {
    Track { container: usize, track: usize },
    Playlist { index: usize },
}

/// The key a destination's record is filed under: the folded folder path, or `device:` and the folded
/// device breadcrumb.
pub fn dest_key(config: &ExportConfig) -> String {
    match &config.device {
        Some(device) => format!("device:{}", normalize_path_key(&device.display)),
        None => normalize_path_key(&config.destination),
    }
}

/// Every file the job writes when nothing is skipped as unchanged, in plan order then playlist
/// order: each present track of each in-scope container, then each playlist file.
pub fn export_files(job: &ExportJob) -> Vec<ExportFile> {
    let mut files = Vec::new();
    for (ci, (container, clayout)) in job.plan.containers.iter().zip(&job.layout).enumerate() {
        if !job.in_scope(ci) {
            continue;
        }
        for (ti, (track, tlayout)) in container.tracks.iter().zip(&clayout.tracks).enumerate() {
            let rel_path = clayout
                .rel_dir
                .join(&tlayout.filename)
                .to_string_lossy()
                .replace('\\', "/");
            files.push(ExportFile {
                fingerprint: track_fingerprint(&rel_path, container, track),
                rel_path,
                kind: FileKind::Track {
                    container: ci,
                    track: ti,
                },
            });
        }
    }
    for (index, playlist) in job.playlist_files.iter().enumerate() {
        let rel_path = playlist.rel_path();
        files.push(ExportFile {
            fingerprint: playlist_fingerprint(&rel_path, &playlist.content),
            rel_path,
            kind: FileKind::Playlist { index },
        });
    }
    files
}

/// Flags each file whose fingerprint differs from the recorded one or that has no row.
pub fn changed(files: &[ExportFile], recorded: &HashMap<String, String>) -> Vec<bool> {
    files
        .iter()
        .map(|f| recorded.get(&f.rel_path) != Some(&f.fingerprint))
        .collect()
}

/// Tallies a diff for the preview: the changed files, and the albums, singles and playlists holding at
/// least one. A playlist counts once across its folder and its playlist file, by name.
pub fn change_set(
    job: &ExportJob,
    files: &[ExportFile],
    changed: &[bool],
    last_exported_at: Option<i64>,
) -> ExportChangeSet {
    let mut albums: HashSet<usize> = HashSet::new();
    let mut singles: HashSet<usize> = HashSet::new();
    let mut playlists: HashSet<&str> = HashSet::new();
    for (file, _) in files.iter().zip(changed).filter(|(_, &c)| c) {
        match file.kind {
            FileKind::Track { container, .. } => {
                let c = &job.plan.containers[container];
                match (&c.bucket, c.kind) {
                    (Bucket::Playlist(name), _) => {
                        playlists.insert(name);
                    }
                    (_, ContainerKind::Single) => {
                        singles.insert(container);
                    }
                    _ => {
                        albums.insert(container);
                    }
                }
            }
            FileKind::Playlist { index } => {
                playlists.insert(&job.playlist_files[index].name);
            }
        }
    }
    ExportChangeSet {
        has_record: last_exported_at.is_some(),
        last_exported_at,
        albums: albums.len() as u32,
        singles: singles.len() as u32,
        playlists: playlists.len() as u32,
        files: changed.iter().filter(|&&c| c).count() as u32,
        total_files: files.len() as u32,
    }
}

/// The `(rel_path, fingerprint)` rows a finished run earns: each track its report marks exported, and
/// each playlist file that landed. A failed or unattempted file earns none, so it reads as changed
/// next time.
pub fn landed_rows(
    job: &ExportJob,
    files: &[ExportFile],
    items: &[ExportItem],
    landed_playlists: &[String],
) -> Vec<(String, String)> {
    // A report row names its track by container label and track id; the pair is unique, since no two
    // containers share a folder.
    let mut by_item: HashMap<(String, i64), &ExportFile> = HashMap::new();
    let mut by_path: HashMap<&str, &ExportFile> = HashMap::new();
    for file in files {
        match file.kind {
            FileKind::Track { container, track } => {
                let label = container_name(&job.layout[container].rel_dir);
                let track_id = job.plan.containers[container].tracks[track].track_id;
                by_item.insert((label, track_id), file);
            }
            FileKind::Playlist { .. } => {
                by_path.insert(&file.rel_path, file);
            }
        }
    }

    let tracks = items
        .iter()
        .filter(|item| matches!(item.status, ExportItemStatus::Exported))
        .filter_map(|item| by_item.get(&(item.container.clone(), item.track_id)));
    let playlists = landed_playlists
        .iter()
        .filter_map(|path| by_path.get(path.as_str()));
    tracks
        .chain(playlists)
        .map(|file| (file.rel_path.clone(), file.fingerprint.clone()))
        .collect()
}

/// A track copy's fingerprint: where it lands, the source it copies with that file's stats, the exact
/// tags written, and the identity of the art it embeds.
fn track_fingerprint(rel_path: &str, container: &ExportContainer, track: &ExportTrack) -> String {
    let mut h = blake3::Hasher::new();
    h.update(&LEDGER_VERSION.to_le_bytes());
    put_bytes(&mut h, TRACK_FILE);
    put_str(&mut h, Some(rel_path));
    put_str(&mut h, Some(&track.source));
    put_int(&mut h, Some(track.size_bytes));
    put_int(&mut h, Some(track.mtime));

    let tags = track_tags(container, track);
    put_str(&mut h, tags.title);
    put_str(&mut h, tags.artist);
    put_str(&mut h, tags.album);
    put_str(&mut h, tags.album_artist);
    put_int(&mut h, tags.year);
    put_int(&mut h, Some(tags.genres.len() as i64));
    for genre in tags.genres {
        put_str(&mut h, Some(genre));
    }
    put_int(&mut h, tags.track_no);
    put_int(&mut h, tags.disc_no);

    put_cover(&mut h, container, track);
    h.finalize().to_hex().to_string()
}

/// A playlist file's fingerprint: where it lands and its rendered bytes.
fn playlist_fingerprint(rel_path: &str, content: &str) -> String {
    let mut h = blake3::Hasher::new();
    h.update(&LEDGER_VERSION.to_le_bytes());
    put_bytes(&mut h, PLAYLIST_FILE);
    put_str(&mut h, Some(rel_path));
    put_bytes(&mut h, content.as_bytes());
    h.finalize().to_hex().to_string()
}

/// Hashes the identity of the art a track embeds, walking the writer's own precedence: an assigned
/// cover is its stored blob; a keep-own track hashes its own source, then the container cover it falls
/// back to when it has no art; everything else hashes the container cover. The folder-cover tier never
/// reaches an export, so it plays no part.
fn put_cover(h: &mut blake3::Hasher, container: &ExportContainer, track: &ExportTrack) {
    if let CoverPlan::Store { content_hash, .. } = &track.own_cover {
        put_bytes(h, COVER_STORE);
        put_str(h, Some(content_hash));
        return;
    }
    if track.keep_own_cover {
        put_member(h, Some(track), &track.source);
    }
    match &container.cover {
        CoverPlan::Store { content_hash, .. } => {
            put_bytes(h, COVER_STORE);
            put_str(h, Some(content_hash));
        }
        CoverPlan::Member { source, .. } => {
            let member = container.tracks.iter().find(|t| t.source == *source);
            put_member(h, member, source);
        }
        CoverPlan::None => put_bytes(h, COVER_NONE),
    }
}

/// Hashes embedded or adjacent art by the member source that carries it: its path, size and mtime.
fn put_member(h: &mut blake3::Hasher, member: Option<&ExportTrack>, source: &str) {
    put_bytes(h, COVER_MEMBER);
    put_str(h, Some(source));
    put_int(h, member.map(|t| t.size_bytes));
    put_int(h, member.map(|t| t.mtime));
}

/// Hashes a byte run behind its length, so two neighbouring inputs can never trade bytes.
fn put_bytes(h: &mut blake3::Hasher, bytes: &[u8]) {
    h.update(&(bytes.len() as u64).to_le_bytes());
    h.update(bytes);
}

/// Hashes an optional string behind a presence byte, so an unset value never equals an empty one.
fn put_str(h: &mut blake3::Hasher, value: Option<&str>) {
    match value {
        Some(s) => {
            h.update(&[1]);
            put_bytes(h, s.as_bytes());
        }
        None => {
            h.update(&[0]);
        }
    }
}

/// Hashes an optional integer behind a presence byte.
fn put_int(h: &mut blake3::Hasher, value: Option<i64>) {
    match value {
        Some(n) => {
            h.update(&[1]);
            h.update(&n.to_le_bytes());
        }
        None => {
            h.update(&[0]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::DeviceTarget;

    fn track() -> ExportTrack {
        ExportTrack {
            track_id: 1,
            source: "/m/1.flac".into(),
            ext: "flac".into(),
            size_bytes: 100,
            mtime: 200,
            title: Some("Song".into()),
            artist: Some("Artist".into()),
            album_override: None,
            album_artist_override: None,
            year_override: None,
            genres: vec!["Rock".into(), "Pop".into()],
            track_no: Some(1),
            disc_no: Some(1),
            has_embedded: true,
            keep_own_cover: false,
            own_cover: CoverPlan::None,
        }
    }

    fn container(tracks: Vec<ExportTrack>) -> ExportContainer {
        ExportContainer {
            album_id: 1,
            kind: ContainerKind::Album,
            bucket: Bucket::Albums,
            flat: false,
            album_artist: Some("Artist".into()),
            title: Some("Album".into()),
            year: Some(2001),
            cover: CoverPlan::Member {
                source: "/m/1.flac".into(),
                has_embedded: true,
            },
            tracks,
            skipped: Vec::new(),
        }
    }

    fn print(c: &ExportContainer) -> String {
        track_fingerprint("Albums/Artist/Album/01 - Song.flac", c, &c.tracks[0])
    }

    #[test]
    fn a_fingerprint_is_deterministic_hex() {
        let c = container(vec![track()]);
        let a = print(&c);
        assert_eq!(a, print(&c.clone()));
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    // One change applied to a copy of the base container.
    type Edit = Box<dyn Fn(&mut ExportContainer)>;

    #[test]
    fn every_input_moves_the_fingerprint() {
        let base = container(vec![track()]);
        let before = print(&base);
        let edits: Vec<(&str, Edit)> = vec![
            ("size", Box::new(|c| c.tracks[0].size_bytes = 101)),
            ("mtime", Box::new(|c| c.tracks[0].mtime = 201)),
            (
                "source",
                Box::new(|c| c.tracks[0].source = "/m/2.flac".into()),
            ),
            (
                "title",
                Box::new(|c| c.tracks[0].title = Some("Other".into())),
            ),
            ("artist", Box::new(|c| c.tracks[0].artist = None)),
            ("album", Box::new(|c| c.title = Some("Other".into()))),
            (
                "album artist",
                Box::new(|c| c.tracks[0].album_artist_override = Some("X".into())),
            ),
            ("year", Box::new(|c| c.tracks[0].year_override = Some(1999))),
            ("genre order", Box::new(|c| c.tracks[0].genres.reverse())),
            ("track no", Box::new(|c| c.tracks[0].track_no = Some(2))),
            ("disc no", Box::new(|c| c.tracks[0].disc_no = None)),
            ("keep own", Box::new(|c| c.tracks[0].keep_own_cover = true)),
            (
                "own cover",
                Box::new(|c| {
                    c.tracks[0].own_cover = CoverPlan::Store {
                        content_hash: "abc".into(),
                        byte_len: 3,
                    }
                }),
            ),
            (
                "album cover",
                Box::new(|c| {
                    c.cover = CoverPlan::Store {
                        content_hash: "def".into(),
                        byte_len: 3,
                    }
                }),
            ),
            ("no cover", Box::new(|c| c.cover = CoverPlan::None)),
        ];
        for (label, edit) in edits {
            let mut c = base.clone();
            edit(&mut c);
            assert_ne!(print(&c), before, "{label} moves the fingerprint");
        }
        assert_ne!(
            track_fingerprint("Albums/Artist/Album/02 - Song.flac", &base, &base.tracks[0]),
            before,
            "the destination path moves the fingerprint"
        );
    }

    #[test]
    fn a_member_cover_follows_its_members_stats() {
        // The second track embeds the first track's art, so the first file's stats reach it.
        let mut second = track();
        second.track_id = 2;
        second.source = "/m/2.flac".into();
        let c = container(vec![track(), second]);
        let before = track_fingerprint("x", &c, &c.tracks[1]);
        let mut bumped = c.clone();
        bumped.tracks[0].mtime = 999;
        assert_ne!(track_fingerprint("x", &bumped, &bumped.tracks[1]), before);
    }

    #[test]
    fn changed_flags_new_and_moved_files_only() {
        let file = |rel: &str, fp: &str| ExportFile {
            rel_path: rel.into(),
            fingerprint: fp.into(),
            kind: FileKind::Playlist { index: 0 },
        };
        let files = vec![file("a", "1"), file("b", "2"), file("c", "3")];
        let recorded: HashMap<String, String> = [
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "9".to_string()),
        ]
        .into();
        assert_eq!(changed(&files, &recorded), vec![false, true, true]);
    }

    #[test]
    fn a_device_key_is_distinct_from_a_folder_key() {
        let mut config = ExportConfig {
            destination: "D:\\Out".into(),
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
        };
        let folder = dest_key(&config);
        assert_eq!(folder, normalize_path_key("D:\\Out"));
        config.device = Some(DeviceTarget {
            device_name: "Phone".into(),
            display: "Phone > Music".into(),
            pidl: "00".into(),
        });
        let device = dest_key(&config);
        assert!(device.starts_with("device:"));
        assert_eq!(
            device,
            dest_key(&config.clone()),
            "the key is deterministic"
        );
    }
}
