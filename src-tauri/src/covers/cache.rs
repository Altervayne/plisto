/*
 * The content-addressed thumbnail cache. A generated thumb lives at
 * <covers_dir>/<content_hash>_<edge>.jpg, so a warm hit is a Path::exists with no decode and no
 * DB touch. The in-flight guard collapses a burst of identical requests to a single decode:
 * concurrent callers for the same key wait on the first instead of each re-decoding the same
 * art. Generation writes through a temp file then renames, so a reader never sees a half-written
 * thumbnail.
 */

// -- Library Imports --
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};

// -- Local Imports --
use super::thumbnail::thumbnail;

/// Serializes generation of identical thumbnails. A key is held while its thumbnail decodes and
/// writes; other callers for the same key wait until it is released and then find a warm file.
/// Keyed by `<content_hash>_<edge>`.
#[derive(Default)]
pub struct InFlightGuard {
    active: Mutex<HashSet<String>>,
    freed: Condvar,
}

impl InFlightGuard {
    /// Claims `key`, blocking while another caller holds it. The returned claim releases the key
    /// and wakes waiters when dropped.
    fn claim(&self, key: &str) -> Claim<'_> {
        let mut active = self.active.lock().unwrap();
        while active.contains(key) {
            active = self.freed.wait(active).unwrap();
        }
        active.insert(key.to_string());
        Claim {
            guard: self,
            key: key.to_string(),
        }
    }
}

/// The RAII release for one claimed key.
struct Claim<'a> {
    guard: &'a InFlightGuard,
    key: String,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.guard.active.lock().unwrap().remove(&self.key);
        self.guard.freed.notify_all();
    }
}

/// The cache path for a thumbnail of the given content hash at the given longest edge.
pub fn thumb_cache_path(covers_dir: &Path, content_hash: &str, max_edge: u32) -> PathBuf {
    covers_dir.join(format!("{content_hash}_{max_edge}.jpg"))
}

/// Ensures a thumbnail of `raw_bytes` at `max_edge` exists in the cache and returns its path. A
/// warm file is returned untouched, without decoding or rewriting. On a miss, one caller decodes
/// and writes while identical concurrent callers wait through the guard. Errors when the source
/// cannot be decoded or the cache cannot be written.
pub fn ensure_thumb(
    covers_dir: &Path,
    content_hash: &str,
    raw_bytes: &[u8],
    max_edge: u32,
    guard: &InFlightGuard,
) -> Result<PathBuf, String> {
    let path = thumb_cache_path(covers_dir, content_hash, max_edge);
    if path.exists() {
        return Ok(path);
    }

    let key = format!("{content_hash}_{max_edge}");
    let _claim = guard.claim(&key);

    // The winner of the race may have written it while this caller waited on the guard.
    if path.exists() {
        return Ok(path);
    }

    let encoded = thumbnail(raw_bytes, max_edge).map_err(|e| e.to_string())?;
    write_atomic(&path, &encoded)?;
    Ok(path)
}

/// Writes `bytes` to `path` by staging a temp file beside it and renaming into place, so a
/// concurrent reader sees either the old file or the whole new one, never a partial write.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("jpg.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;
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
                .join(format!("plisto_cache_{}_{n}_{nanos}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // A solid-colour PNG of the given size, in memory.
    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = RgbImage::from_pixel(width, height, Rgb([10, 120, 200]));
        let mut buf = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    fn hash(bytes: &[u8]) -> String {
        blake3::hash(bytes).to_hex().to_string()
    }

    #[test]
    fn same_bytes_and_size_yield_the_same_path() {
        let dir = TempDir::new();
        let guard = InFlightGuard::default();
        let bytes = png_bytes(40, 40);
        let h = hash(&bytes);

        let a = ensure_thumb(&dir.path, &h, &bytes, 16, &guard).unwrap();
        let b = ensure_thumb(&dir.path, &h, &bytes, 16, &guard).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn a_warm_file_is_not_regenerated() {
        let dir = TempDir::new();
        let guard = InFlightGuard::default();
        let bytes = png_bytes(40, 40);
        let h = hash(&bytes);

        let path = ensure_thumb(&dir.path, &h, &bytes, 16, &guard).unwrap();
        let first_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();

        // Feeding garbage on the warm path must be a no-op: the existing file is returned without
        // any decode, so undecodable bytes never surface as an error and the file is untouched.
        let again = ensure_thumb(&dir.path, &h, b"not an image", 16, &guard).unwrap();
        assert_eq!(again, path);
        let second_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(first_mtime, second_mtime, "the warm file is not rewritten");
    }

    #[test]
    fn a_different_size_is_a_different_path() {
        let dir = TempDir::new();
        let guard = InFlightGuard::default();
        let bytes = png_bytes(40, 40);
        let h = hash(&bytes);

        let small = ensure_thumb(&dir.path, &h, &bytes, 16, &guard).unwrap();
        let large = ensure_thumb(&dir.path, &h, &bytes, 32, &guard).unwrap();
        assert_ne!(small, large);
    }

    #[test]
    fn undecodable_source_errors_on_a_cold_miss() {
        let dir = TempDir::new();
        let guard = InFlightGuard::default();
        assert!(ensure_thumb(&dir.path, "deadbeef", b"not an image", 16, &guard).is_err());
    }
}
