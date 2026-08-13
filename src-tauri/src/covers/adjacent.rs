/*
 * Adjacent-image discovery: the art that sits next to a track on disk. Scans the track's own
 * folder for the conventional cover filenames and returns the matches in a fixed priority, so
 * the resolver upstream can take the first one. Read-only; it never writes to the source folder.
 */

// -- Library Imports --
use std::path::{Path, PathBuf};

// The conventional cover stems, most-preferred first. Matched case-insensitively.
const COVER_STEMS: &[&str] = &["cover", "folder", "front"];

// The image extensions we accept, most-preferred first. Matched case-insensitively.
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// Lists the cover-like images sitting in the track's folder, ordered by stem priority then
/// extension priority. A file matches when its stem is one of the conventional cover names and
/// its extension is a supported image type, both compared case-insensitively. Returns empty
/// when the folder cannot be read or holds none.
#[allow(dead_code)]
pub fn discover_adjacent_images(track_source_path: &Path) -> Vec<PathBuf> {
    let Some(dir) = track_source_path.parent() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut matches: Vec<(usize, usize, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_lowercase);
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_lowercase);
        let (Some(stem), Some(ext)) = (stem, ext) else {
            continue;
        };
        let Some(stem_rank) = COVER_STEMS.iter().position(|s| *s == stem) else {
            continue;
        };
        let Some(ext_rank) = IMAGE_EXTS.iter().position(|e| *e == ext) else {
            continue;
        };
        matches.push((stem_rank, ext_rank, path));
    }

    matches.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    matches.into_iter().map(|(_, _, path)| path).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A unique throwaway directory under the system temp dir, removed on drop.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("plisto_adjacent_{}_{n}_{nanos}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn finds_images_in_priority_order_and_ignores_others() {
        let dir = TempDir::new();
        fs::write(dir.path.join("folder.png"), b"x").unwrap();
        fs::write(dir.path.join("cover.jpg"), b"x").unwrap();
        fs::write(dir.path.join("notes.txt"), b"x").unwrap();
        fs::write(dir.path.join("song.mp3"), b"x").unwrap();

        let found = discover_adjacent_images(&dir.path.join("song.mp3"));
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["cover.jpg", "folder.png"]);
    }

    #[test]
    fn case_insensitive_match() {
        let dir = TempDir::new();
        fs::write(dir.path.join("Cover.JPG"), b"x").unwrap();

        let found = discover_adjacent_images(&dir.path.join("song.mp3"));
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn empty_folder_returns_none() {
        let dir = TempDir::new();
        let found = discover_adjacent_images(&dir.path.join("song.mp3"));
        assert!(found.is_empty());
    }
}
