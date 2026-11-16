/*
 * Staging files opened from outside the library: each file's tags, gain and cover are read in one
 * decode helper for the whole burst, so this process parses no byte of them, and the cover is cached
 * from the thumbnails the helper scaled. Only when no helper can be set up here are files read
 * in-process. A file the helper faults on, whose tags are not read in time, or whose staging panics,
 * is dropped and the burst goes on; a cover that fails only leaves the file without one.
 *
 * A folder is looked at only for a readable file with no picture of its own, and once per burst.
 */

// -- Library Imports --
use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

// -- Local Imports --
use super::{ad_hoc_display, ad_hoc_gain, read_in_process};
use crate::adhoc::AdHocTrack;
use crate::audio::stream::isolate::inspect::{InspectBurst, InspectedFile, Inspection};
use crate::commands::covers::{cache_inspected_cover, AD_HOC_EDGES};
use crate::covers::{discover_adjacent_images, InFlightGuard};
use crate::model::RawTags;

#[cfg(test)]
thread_local! {
    /// A path whose staging panics once its tags are read.
    static PANIC_ON: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// The image beside each folder's files, found at most once per burst.
#[derive(Default)]
pub(super) struct Folders {
    first_image: HashMap<PathBuf, Option<PathBuf>>,
    /// Folders listed.
    #[cfg(test)]
    listed: usize,
}

impl Folders {
    // The cover-like image beside `path`, from its folder's one listing.
    fn image_beside(&mut self, path: &Path) -> Option<PathBuf> {
        let folder = path.parent()?.to_path_buf();
        if let Some(image) = self.first_image.get(&folder) {
            return image.clone();
        }
        #[cfg(test)]
        {
            self.listed += 1;
        }
        let image = discover_adjacent_images(path).into_iter().next();
        self.first_image.insert(folder, image.clone());
        image
    }
}

/// Reads tags and caches a cover for each path, dropping any file that cannot be read as audio, and
/// keeping the caller's order among the survivors. Each survivor carries its tagged levelling gain.
pub(super) fn read_ad_hoc_tracks(
    covers_dir: &Path,
    guard: &InFlightGuard,
    paths: Vec<String>,
) -> Vec<(String, AdHocTrack, f32)> {
    let mut burst = InspectBurst::new(AD_HOC_EDGES);
    read_with(
        covers_dir,
        guard,
        paths,
        &mut burst,
        &mut Folders::default(),
    )
}

/// `read_ad_hoc_tracks` through `burst`, looking beside files through `folders`.
pub(super) fn read_with(
    covers_dir: &Path,
    guard: &InFlightGuard,
    paths: Vec<String>,
    burst: &mut InspectBurst,
    folders: &mut Folders,
) -> Vec<(String, AdHocTrack, f32)> {
    let mut readable = Vec::with_capacity(paths.len());
    for path in paths {
        let staged = panic::catch_unwind(AssertUnwindSafe(|| {
            read_ad_hoc_track(covers_dir, guard, burst, folders, &path)
        }));
        match staged {
            Ok(Ok((track, gain_db))) => readable.push((path, track, gain_db)),
            Ok(Err(_)) => {}
            // The helper may be partway through an answer: the next file gets a new one.
            Err(_) => burst.reset(),
        }
    }
    readable
}

/// One file's display, cover and gain, as `read_in_process` builds them, from the burst's helper.
fn read_ad_hoc_track(
    covers_dir: &Path,
    guard: &InFlightGuard,
    burst: &mut InspectBurst,
    folders: &mut Folders,
    source_path: &str,
) -> Result<(AdHocTrack, f32), String> {
    let path = Path::new(source_path);
    let file = match burst.read_tags(path) {
        Inspection::Read(file) => file,
        Inspection::InProcess => return read_in_process(covers_dir, guard, source_path),
        Inspection::Unreadable | Inspection::Faulted | Inspection::Slow | Inspection::Dropped => {
            return Err("couldn't read this file".to_string())
        }
    };
    #[cfg(test)]
    if PANIC_ON.with_borrow(|on| on.as_deref() == Some(source_path)) {
        panic!("staging panics on {source_path}");
    }
    let cover = if file.has_picture {
        burst.cover(None)
    } else {
        folders
            .image_beside(path)
            .and_then(|image| burst.cover(Some(&image)))
    };
    let cover = cover.and_then(|cover| cache_inspected_cover(covers_dir, guard, cover));
    let raw = raw_tags(file);
    let (title, artist) = ad_hoc_display(source_path, &raw);
    let track = AdHocTrack {
        title,
        artist,
        cover,
    };
    Ok((track, ad_hoc_gain(source_path, &raw)))
}

/// The raw tags the display and gain read, from the helper's answer.
fn raw_tags(file: InspectedFile) -> RawTags {
    RawTags {
        title: file.title,
        artist: file.artist,
        rg_track_gain: file.track_gain,
        rg_track_peak: file.track_peak,
        duration_secs: file.duration_secs,
        ..RawTags::default()
    }
}

#[cfg(test)]
mod tests;
