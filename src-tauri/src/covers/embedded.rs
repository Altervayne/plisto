/*
 * Reading embedded album art back out of an audio file at command time. Mirrors the detection
 * in the scan (prefer a front-cover frame, fall back to the first picture) but returns the raw
 * picture bytes so the thumbnail pipeline can decode them. Read-only: the audio file is only
 * opened, never written.
 */

// -- Library Imports --
use std::path::Path;

use lofty::picture::PictureType;
use lofty::prelude::TaggedFileExt;

/// Returns the raw bytes of the file's cover picture, or None when lofty cannot open it or it
/// carries no picture. Prefers a CoverFront frame and falls back to the first picture, matching
/// how the scan records `has_embedded_cover`.
pub fn read_embedded_cover_bytes(path: &Path) -> Option<Vec<u8>> {
    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;

    let pictures = tag.pictures();
    let picture = pictures
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| pictures.first())?;
    Some(picture.data().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    // A unique throwaway file under the system temp dir, removed on drop.
    struct TempFile {
        path: PathBuf,
    }

    impl TempFile {
        fn new(bytes: &[u8]) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "plisto_embedded_{}_{n}_{nanos}.mp3",
                std::process::id()
            ));
            fs::write(&path, bytes).unwrap();
            Self { path }
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    #[test]
    fn unreadable_file_yields_none() {
        // An empty file lofty cannot open carries no picture bytes.
        let file = TempFile::new(b"");
        assert!(read_embedded_cover_bytes(&file.path).is_none());
    }
}
