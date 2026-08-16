/*
 * The image-discovery sweep: walk the library roots for loose images grouped by folder, and
 * reconcile each folder against the cover bindings so the covers workspace lands on a "needs cover"
 * signal. The walk is cheap - readdir plus an extension test, never a decode - so a full sweep can
 * feed the library-wide needs-cover sort. Cancellation is an atomic flag checked between walk
 * entries and between emitted groups, so a stopped sweep leaves the DB untouched: it only reads.
 * The reconciliation runs against a snapshot read once under the lock, so the walk holds nothing.
 */

// -- Library Imports --
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use walkdir::WalkDir;

// -- Local Imports --
use crate::covers::is_adjacent_image;
use crate::db::FolderTrackState;
use crate::dto::{AlbumBrief, ImageFolderGroup};
use crate::normalize::{folder_of, normalize_path_key};

// The image extensions the sweep collects, matched case-insensitively. A superset of the adjacent-
// art set (it adds bmp) with no stem restriction: the sweep surfaces every image in a folder, and
// the resolver's own stem rules decide which of them count as existing art.
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];

/// True when `ext` names a loose image the sweep collects. Case-insensitive and tolerant of a
/// leading dot, mirroring `is_audio`.
pub fn is_library_image(ext: &str) -> bool {
    let ext = ext.trim_start_matches('.').to_lowercase();
    IMAGE_EXTS.contains(&ext.as_str())
}

/// The album title and cover state for one album, the AlbumBrief inputs the sweep attaches when a
/// folder resolves to exactly one album.
pub struct AlbumBriefData {
    pub title: Option<String>,
    pub has_cover: bool,
}

/// One folder's rolled-up track state: how many non-missing tracks it holds, the distinct albums
/// they belong to, and whether any track resolves to no art of its own (no per-track cover and no
/// embedded art). Folder-wide art - a bound folder cover or an adjacent image - is applied on top of
/// this, so `has_bare_track` is the per-track half of the needs-cover decision.
#[derive(Default)]
struct FolderAgg {
    track_count: i64,
    album_ids: HashSet<i64>,
    has_bare_track: bool,
}

/// The DB view the sweep reconciles each folder against, read once under the lock before the walk:
/// which folders already carry a bound cover, each folder's rolled-up track state keyed by its
/// folded path, and the album briefs to attach when a folder resolves to exactly one album.
pub struct DiscoverySnapshot {
    folder_covers: HashSet<String>,
    folders: HashMap<String, FolderAgg>,
    albums: HashMap<i64, AlbumBriefData>,
}

impl DiscoverySnapshot {
    /// Rolls the raw DB reads into the per-folder view. `folder_cover_paths` are the folded folder
    /// keys that already carry a cover; `track_states` are every present track's state, grouped here
    /// by its folder; `albums` are `(id, title, has_cover)` for the exactly-one-album lookup.
    pub fn build(
        folder_cover_paths: Vec<String>,
        track_states: Vec<FolderTrackState>,
        albums: Vec<(i64, Option<String>, bool)>,
    ) -> Self {
        let folder_covers = folder_cover_paths.into_iter().collect();

        let mut folders: HashMap<String, FolderAgg> = HashMap::new();
        for st in track_states {
            let agg = folders.entry(folder_of(&st.source_path)).or_default();
            agg.track_count += 1;
            if let Some(id) = st.album_id {
                agg.album_ids.insert(id);
            }
            // A track resolves to nothing of its own when it has no per-track cover and no embedded
            // art; a tri-state NULL flag is not "has embedded", so it counts as bare.
            if !st.has_track_cover && st.has_embedded_cover != Some(true) {
                agg.has_bare_track = true;
            }
        }

        let albums = albums
            .into_iter()
            .map(|(id, title, has_cover)| (id, AlbumBriefData { title, has_cover }))
            .collect();

        Self {
            folder_covers,
            folders,
            albums,
        }
    }

    /// Whether a folder needs a cover: no bound folder cover, no adjacent art on disk, and at least
    /// one member track that resolves to nothing of its own. A bound folder cover or an adjacent
    /// image is folder-wide, so either one covers every member and drops the need; a folder with no
    /// tracks (an image-only subfolder) never needs one.
    fn needs_cover(&self, folder_key: &str, has_adjacent: bool) -> bool {
        if has_adjacent || self.folder_covers.contains(folder_key) {
            return false;
        }
        self.folders
            .get(folder_key)
            .map(|a| a.has_bare_track)
            .unwrap_or(false)
    }

    /// The album to attach and the non-missing track count for a folder. An album brief comes back
    /// only when the folder's tracks resolve to exactly one album; none for zero or several.
    fn album_and_count(&self, folder_key: &str) -> (Option<AlbumBrief>, i64) {
        let Some(agg) = self.folders.get(folder_key) else {
            return (None, 0);
        };
        let album = if agg.album_ids.len() == 1 {
            let id = *agg.album_ids.iter().next().unwrap();
            self.albums.get(&id).map(|b| AlbumBrief {
                id,
                title: b.title.clone(),
                has_cover: b.has_cover,
            })
        } else {
            None
        };
        (album, agg.track_count)
    }
}

/// Walks `roots` for loose images, groups them by their real-case parent folder, and emits one
/// `ImageFolderGroup` per folder that holds at least one, each with its needs-cover reconciliation
/// against `snapshot`. Path only - no decode, no hash - so a huge library pays just readdir and an
/// extension test. `cancel` stops the walk between entries and the emit between folders, returning
/// early with whatever has been sent. The music folders and the index are never written.
pub fn run_discovery<E>(
    roots: &[PathBuf],
    snapshot: &DiscoverySnapshot,
    cancel: &Arc<AtomicBool>,
    emit: E,
) -> Result<(), String>
where
    E: Fn(ImageFolderGroup),
{
    // Group loose images by their real-case parent folder. A BTreeMap keeps the emitted folders in
    // a stable order rather than HashMap's arbitrary one.
    let mut by_folder: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for root in roots {
        for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let is_img = entry
                .path()
                .extension()
                .map(|e| is_library_image(&e.to_string_lossy()))
                .unwrap_or(false);
            if !is_img {
                continue;
            }
            let path = entry.into_path();
            let Some(folder) = path.parent().map(|p| p.to_string_lossy().into_owned()) else {
                continue;
            };
            by_folder
                .entry(folder)
                .or_default()
                .push(path.to_string_lossy().into_owned());
        }
    }

    for (folder, mut images) in by_folder {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        images.sort();

        // Fold the real-case folder to the key the bindings use, so it matches folder_of over the
        // stored (folded) source paths.
        let key = normalize_path_key(&folder);
        let has_adjacent = images.iter().any(|p| is_adjacent_image(Path::new(p)));
        let needs_cover = snapshot.needs_cover(&key, has_adjacent);
        let (album, track_count) = snapshot.album_and_count(&key);
        let folder_name = Path::new(&folder)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder.clone());

        emit(ImageFolderGroup {
            folder_path: folder,
            folder_name,
            images,
            needs_cover,
            album,
            track_count,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A track-state row in a given folder, with knobs for the needs-cover inputs.
    fn state(
        source_path: &str,
        has_embedded: Option<bool>,
        has_track_cover: bool,
        album_id: Option<i64>,
    ) -> FolderTrackState {
        FolderTrackState {
            source_path: source_path.to_string(),
            has_embedded_cover: has_embedded,
            has_track_cover,
            album_id,
        }
    }

    #[test]
    fn library_image_predicate_accepts_image_exts_only() {
        for ext in ["jpg", "jpeg", "png", "webp", "gif", "bmp"] {
            assert!(is_library_image(ext), "{ext} is an image");
            assert!(is_library_image(&ext.to_uppercase()), "case-insensitive");
            assert!(is_library_image(&format!(".{ext}")), "leading dot tolerated");
        }
        assert!(!is_library_image("mp3"));
        assert!(!is_library_image("txt"));
        assert!(!is_library_image("tiff"));
        assert!(!is_library_image(""));
    }

    #[test]
    fn bare_folder_needs_a_cover() {
        // One track, no per-track cover, no embedded art, no folder cover, no adjacent image.
        let snap = DiscoverySnapshot::build(
            vec![],
            vec![state("/m/bare/a.mp3", Some(false), false, None)],
            vec![],
        );
        assert!(snap.needs_cover("/m/bare", false), "a bare folder is needy");
    }

    #[test]
    fn null_embedded_flag_is_treated_as_bare() {
        // A tri-state NULL art flag is not "has embedded", so the track still resolves to nothing.
        let snap = DiscoverySnapshot::build(
            vec![],
            vec![state("/m/unknown/a.mp3", None, false, None)],
            vec![],
        );
        assert!(snap.needs_cover("/m/unknown", false));
    }

    #[test]
    fn folder_with_a_bound_cover_is_not_needy() {
        let snap = DiscoverySnapshot::build(
            vec!["/m/covered".to_string()],
            vec![state("/m/covered/a.mp3", Some(false), false, None)],
            vec![],
        );
        assert!(!snap.needs_cover("/m/covered", false), "the bound cover fills it");
    }

    #[test]
    fn folder_whose_tracks_have_embedded_art_is_not_needy() {
        let snap = DiscoverySnapshot::build(
            vec![],
            vec![state("/m/embedded/a.mp3", Some(true), false, None)],
            vec![],
        );
        assert!(!snap.needs_cover("/m/embedded", false));
    }

    #[test]
    fn folder_with_an_adjacent_image_is_not_needy() {
        // The track has no art of its own, but a loose adjacent image sits next to it on disk.
        let snap = DiscoverySnapshot::build(
            vec![],
            vec![state("/m/adjacent/a.mp3", Some(false), false, None)],
            vec![],
        );
        assert!(
            !snap.needs_cover("/m/adjacent", true),
            "an adjacent image covers every member"
        );
    }

    #[test]
    fn per_track_cover_clears_the_only_bare_track() {
        let snap = DiscoverySnapshot::build(
            vec![],
            vec![state("/m/assigned/a.mp3", Some(false), true, None)],
            vec![],
        );
        assert!(!snap.needs_cover("/m/assigned", false));
    }

    #[test]
    fn image_only_folder_never_needs_a_cover() {
        // No tracks map to this folder at all (an image-only subfolder), so there is no demand.
        let snap = DiscoverySnapshot::build(vec![], vec![], vec![]);
        assert!(!snap.needs_cover("/m/scans", false));
        let (album, count) = snap.album_and_count("/m/scans");
        assert!(album.is_none());
        assert_eq!(count, 0);
    }

    #[test]
    fn one_album_folder_attaches_its_brief() {
        let snap = DiscoverySnapshot::build(
            vec![],
            vec![
                state("/m/one/a.mp3", Some(true), false, Some(7)),
                state("/m/one/b.mp3", Some(true), false, Some(7)),
            ],
            vec![(7, Some("Only One".to_string()), true)],
        );
        let (album, count) = snap.album_and_count("/m/one");
        let album = album.expect("exactly one album attaches a brief");
        assert_eq!(album.id, 7);
        assert_eq!(album.title.as_deref(), Some("Only One"));
        assert!(album.has_cover);
        assert_eq!(count, 2);
    }

    #[test]
    fn multi_album_folder_attaches_no_brief() {
        let snap = DiscoverySnapshot::build(
            vec![],
            vec![
                state("/m/mixed/a.mp3", Some(true), false, Some(1)),
                state("/m/mixed/b.mp3", Some(true), false, Some(2)),
            ],
            vec![
                (1, Some("A".to_string()), false),
                (2, Some("B".to_string()), false),
            ],
        );
        let (album, count) = snap.album_and_count("/m/mixed");
        assert!(album.is_none(), "several albums attach no brief in v1");
        assert_eq!(count, 2);
    }
}
