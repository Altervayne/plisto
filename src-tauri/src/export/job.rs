/*
 * One general export laid out once: the whole plan, its layout derived over every container, the
 * portable playlist files rendered from that layout, and the scope a run writes. The layout always
 * spans the whole plan, even when a run writes a few containers or a few files, so a scoped or
 * changed-only run lands each file exactly where the general export would, collision suffix included.
 * The record fingerprints and the run both read this one layout, so they never disagree.
 */

// -- Library Imports --
use std::collections::{HashMap, HashSet};

// -- Local Imports --
use super::derive::{
    derive_layout, safe_component, AlbumTemplate, ContainerLayout, PLAYLISTS_ROOT,
};
use super::ledger::{ExportFile, FileKind};
use super::plan::{ExportContainer, ExportPlan};
use super::playlist::{render_m3u, PlaylistExportPlan};

/// A general export laid out over its whole plan. `layout` pairs with `plan.containers` by position.
pub struct ExportJob {
    pub plan: ExportPlan,
    pub layout: Vec<ContainerLayout>,
    pub playlist_files: Vec<PlaylistFile>,
    // The album ids a scoped run writes; None writes every container.
    scope: Option<HashSet<i64>>,
}

/// One portable playlist file of the general export, rendered: the playlist's name, its file name
/// under `Playlists/`, and its body.
pub struct PlaylistFile {
    pub name: String,
    pub file_name: String,
    pub content: String,
}

impl PlaylistFile {
    /// The file's path relative to the export root, with forward slashes.
    pub fn rel_path(&self) -> String {
        format!("{PLAYLISTS_ROOT}/{}", self.file_name)
    }
}

/// The part of a job one run writes: each container holding a file to write, narrowed to those tracks
/// beside its matching layout; the indices of the playlist files to write; and how many tracks the run
/// leaves as they are.
pub struct WriteSet {
    pub containers: Vec<ExportContainer>,
    pub layout: Vec<ContainerLayout>,
    pub playlist_files: Vec<usize>,
    pub unchanged: u32,
}

impl ExportJob {
    /// Lays `plan` out against `dest_len` and `template`, and renders the playlist files from that
    /// layout. `scope` is a scoped run's album id set; an id the plan lacks simply matches nothing.
    pub fn new(
        plan: ExportPlan,
        scope: Option<&[i64]>,
        playlists: &[PlaylistExportPlan],
        dest_len: usize,
        template: &AlbumTemplate,
    ) -> Self {
        let layout = derive_layout(&plan.containers, dest_len, template);
        let playlist_files = render_playlist_files(&layout, playlists);
        Self {
            plan,
            layout,
            playlist_files,
            scope: scope.map(|ids| ids.iter().copied().collect()),
        }
    }

    /// Whether the container at `index` is one this job writes.
    pub fn in_scope(&self, index: usize) -> bool {
        match &self.scope {
            None => true,
            Some(ids) => ids.contains(&self.plan.containers[index].album_id),
        }
    }

    /// Narrows the job to what one run writes: `write` flags each of `files`, the job's own file list.
    /// A container stays when it holds a track to write or a missing-source skip to report.
    pub fn write_set(&self, files: &[ExportFile], write: &[bool]) -> WriteSet {
        let mut keep: Vec<Vec<bool>> = self
            .plan
            .containers
            .iter()
            .map(|c| vec![false; c.tracks.len()])
            .collect();
        let mut playlist_files = Vec::new();
        let mut unchanged = 0;
        for (file, &selected) in files.iter().zip(write) {
            match file.kind {
                FileKind::Track { container, track } if selected => keep[container][track] = true,
                FileKind::Track { .. } => unchanged += 1,
                FileKind::Playlist { index } if selected => playlist_files.push(index),
                FileKind::Playlist { .. } => {}
            }
        }

        let mut containers = Vec::new();
        let mut layout = Vec::new();
        for (i, (container, clayout)) in self.plan.containers.iter().zip(&self.layout).enumerate() {
            let kept = &keep[i];
            let any = kept.iter().any(|&k| k);
            if !self.in_scope(i) || (!any && container.skipped.is_empty()) {
                continue;
            }
            let mut narrowed = container.clone();
            narrowed.tracks = kept_of(&container.tracks, kept);
            containers.push(narrowed);
            layout.push(ContainerLayout {
                rel_dir: clayout.rel_dir.clone(),
                tracks: kept_of(&clayout.tracks, kept),
            });
        }

        WriteSet {
            containers,
            layout,
            playlist_files,
            unchanged,
        }
    }
}

/// The items whose matching `kept` flag is set, in order.
fn kept_of<T: Clone>(items: &[T], kept: &[bool]) -> Vec<T> {
    items
        .iter()
        .zip(kept)
        .filter(|(_, &k)| k)
        .map(|(item, _)| item.clone())
        .collect()
}

/// Renders one portable `.m3u8` per playlist for the general export's `Playlists/` folder, each
/// pointing at the copies the run lands rather than duplicating them: a member or single at its
/// `Albums/`/`Singles/` path is reached with a `../` out of `Playlists/`, while a bagged orphan living
/// under the playlist's own folder is reached without. The path map comes from the job's layout, keyed
/// by track id, so a slot the playlist holds twice names the one copy and a missing-source slot drops
/// out. The files sit beside the copies, so the whole export travels as one portable bundle.
fn render_playlist_files(
    layout: &[ContainerLayout],
    playlists: &[PlaylistExportPlan],
) -> Vec<PlaylistFile> {
    if playlists.is_empty() {
        return Vec::new();
    }

    // The track -> root-relative exported path map.
    let mut rel: HashMap<i64, String> = HashMap::new();
    for clayout in layout {
        for track in &clayout.tracks {
            let path = clayout.rel_dir.join(&track.filename);
            rel.insert(track.track_id, path.to_string_lossy().replace('\\', "/"));
        }
    }
    let inside_prefix = format!("{PLAYLISTS_ROOT}/");

    playlists
        .iter()
        .map(|pl| {
            // Each slot's path is relative to `Playlists/`: a bagged orphan already sits under it, so
            // its prefix is stripped; every other copy is one level up, reached with `../`. render_m3u
            // drops a missing-source slot, and a slot with no mapped copy renders no path.
            let content = render_m3u(pl, |t| match rel.get(&t.track_id) {
                Some(path) => match path.strip_prefix(&inside_prefix) {
                    Some(inside) => inside.to_string(),
                    None => format!("../{path}"),
                },
                None => String::new(),
            });
            let name = pl.name.clone().unwrap_or_else(|| "Playlist".to_string());
            let stem = safe_component(&name, "Playlist");
            PlaylistFile {
                name,
                file_name: format!("{stem}.m3u8"),
                content,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::ledger::export_files;
    use crate::export::plan::{Bucket, ContainerKind, CoverPlan, ExportTrack};

    fn track(track_id: i64, title: &str) -> ExportTrack {
        ExportTrack {
            track_id,
            source: format!("/m/{track_id}.mp3"),
            ext: "mp3".into(),
            size_bytes: 10,
            mtime: 20,
            title: Some(title.into()),
            artist: Some("Artist".into()),
            album_override: None,
            album_artist_override: None,
            year_override: None,
            genres: Vec::new(),
            track_no: Some(track_id),
            disc_no: None,
            has_embedded: false,
            keep_own_cover: false,
            own_cover: CoverPlan::None,
        }
    }

    fn album(album_id: i64, title: &str, tracks: Vec<ExportTrack>) -> ExportContainer {
        ExportContainer {
            album_id,
            kind: ContainerKind::Album,
            bucket: Bucket::Albums,
            flat: false,
            album_artist: Some("Artist".into()),
            title: Some(title.into()),
            year: None,
            cover: CoverPlan::None,
            tracks,
            skipped: Vec::new(),
        }
    }

    fn job(scope: Option<&[i64]>) -> ExportJob {
        let plan = ExportPlan {
            containers: vec![
                album(1, "Same", vec![track(1, "One")]),
                album(2, "Same", vec![track(2, "Two"), track(3, "Three")]),
                album(3, "Other", vec![track(4, "Four")]),
            ],
        };
        ExportJob::new(plan, scope, &[], 0, &AlbumTemplate::resolve("", ""))
    }

    fn rel_dirs(set: &WriteSet) -> Vec<String> {
        set.layout
            .iter()
            .map(|l| l.rel_dir.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    #[test]
    fn a_scoped_job_writes_only_its_ids_in_the_full_layout_folders() {
        // Album 2 collides with album 1 by name; written alone it still takes the suffixed folder.
        let job = job(Some(&[2, 9999]));
        let files = export_files(&job);
        let set = job.write_set(&files, &vec![true; files.len()]);
        assert_eq!(set.containers.len(), 1, "an unknown id matches nothing");
        assert_eq!(set.containers[0].album_id, 2);
        assert_eq!(rel_dirs(&set), vec!["Albums/Artist/Same (2)"]);
    }

    #[test]
    fn an_empty_selection_writes_nothing() {
        let job = job(Some(&[]));
        let files = export_files(&job);
        assert!(files.is_empty());
        let set = job.write_set(&files, &[]);
        assert!(set.containers.is_empty());
    }

    #[test]
    fn a_write_set_narrows_tracks_and_counts_the_rest_unchanged() {
        let job = job(None);
        let files = export_files(&job);
        // Only the third track (album 2's second) is written.
        let write: Vec<bool> = (0..files.len()).map(|i| i == 2).collect();
        let set = job.write_set(&files, &write);
        assert_eq!(set.unchanged, 3);
        assert_eq!(
            set.containers.len(),
            1,
            "a container with nothing to write drops out"
        );
        assert_eq!(set.containers[0].tracks.len(), 1);
        assert_eq!(set.containers[0].tracks[0].track_id, 3);
        assert_eq!(
            set.layout[0].tracks[0].track_id, 3,
            "the layout narrows in step"
        );
        assert_eq!(rel_dirs(&set), vec!["Albums/Artist/Same (2)"]);
    }
}
