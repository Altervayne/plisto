/*
 * Covers cached from thumbnails another process already scaled, as a decode helper returns them for
 * a file opened from outside the library. The cache key is derived here from the pixels this process
 * holds, in blake3's key-derivation mode, which no library cover's key (a plain blake3 of its source
 * bytes) can share: whatever a helper sends, it cannot name or overwrite another cover's thumbnails.
 */

// -- Library Imports --
use std::path::Path;

use image::RgbImage;

// -- Local Imports --
use super::cache::{ensure_scaled_thumbs, InFlightGuard};

const KEY_CONTEXT: &str = "Plisto opened-file cover thumbnails v1";

/// The cache key of `scaled`, given as `(edge, pixels)`: every edge, size and pixel counts.
pub fn scaled_cover_key(scaled: &[(u32, RgbImage)]) -> String {
    let mut hasher = blake3::Hasher::new_derive_key(KEY_CONTEXT);
    for (edge, rgb) in scaled {
        hasher.update(&edge.to_le_bytes());
        hasher.update(&rgb.width().to_le_bytes());
        hasher.update(&rgb.height().to_le_bytes());
        hasher.update(rgb.as_raw());
    }
    hasher.finalize().to_hex().to_string()
}

/// Caches `scaled` at each of its edges under `scaled_cover_key` and returns the key. Warm sizes are
/// left untouched. Errors when the cache cannot be written.
pub fn cache_scaled_cover(
    covers_dir: &Path,
    guard: &InFlightGuard,
    scaled: &[(u32, RgbImage)],
) -> Result<String, String> {
    let key = scaled_cover_key(scaled);
    ensure_scaled_thumbs(covers_dir, &key, scaled, guard)?;
    Ok(key)
}
