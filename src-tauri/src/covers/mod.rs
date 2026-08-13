/*
 * The cover engine: the pure boundary art crosses on its way to the DB, plus the resolution
 * rule that picks a single source. normalize_cover hashes the raw art bytes once (blake3) and
 * builds the persistable manifest row; resolve_track_cover applies the fixed precedence in one
 * place. The decode/resize work and the disk discovery live in the sibling files, framework-
 * free and deterministic so the same input always yields the same output.
 */

// -- Module Declarations --
mod adjacent;
mod thumbnail;

// -- Type Imports --
use crate::model::CoverRecord;

#[allow(unused_imports)]
pub use adjacent::discover_adjacent_images;
#[allow(unused_imports)]
pub use thumbnail::{read_image_dimensions, thumbnail};

/// Where a cover came from, stored as a stable string on the manifest row.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoverSourceKind {
    Embedded,
    Adjacent,
    Imported,
}

impl CoverSourceKind {
    #[allow(dead_code)]
    fn as_str(self) -> &'static str {
        match self {
            CoverSourceKind::Embedded => "embedded",
            CoverSourceKind::Adjacent => "adjacent",
            CoverSourceKind::Imported => "imported",
        }
    }
}

/// The source that wins for a track once precedence is applied.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolvedCover {
    Folder,
    Embedded,
    Adjacent,
    None,
}

/// Builds the manifest row for one piece of art. Pure: it hashes the raw source bytes and
/// records their size and dims, and never decodes or resizes - the hash is over the original
/// art, never a generated thumbnail, so the same source always dedups to one row. Dimensions
/// come pre-validated from read_image_dimensions; the assert guards against a zero slipping in.
#[allow(dead_code)]
pub fn normalize_cover(
    raw_bytes: &[u8],
    width: u32,
    height: u32,
    source_kind: CoverSourceKind,
    origin_path: Option<String>,
    created_at: i64,
) -> CoverRecord {
    debug_assert!(width > 0 && height > 0, "cover dimensions must be positive");

    CoverRecord {
        content_hash: blake3::hash(raw_bytes).to_hex().to_string(),
        source_kind: source_kind.as_str().to_string(),
        origin_path,
        width: width as i64,
        height: height as i64,
        byte_len: raw_bytes.len() as i64,
        created_at,
    }
}

/// Picks the single cover source for a track. A folder cover the user set wins; otherwise the
/// track's own embedded art; otherwise an adjacent image on disk; otherwise nothing. The peek
/// still shows every available source - this only chooses the one resolved thumbnail.
#[allow(dead_code)]
pub fn resolve_track_cover(
    folder_set: bool,
    has_embedded: bool,
    has_adjacent: bool,
) -> ResolvedCover {
    if folder_set {
        ResolvedCover::Folder
    } else if has_embedded {
        ResolvedCover::Embedded
    } else if has_adjacent {
        ResolvedCover::Adjacent
    } else {
        ResolvedCover::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_bytes_hash_the_same() {
        let a = normalize_cover(b"art-bytes", 10, 20, CoverSourceKind::Embedded, None, 1);
        let b = normalize_cover(b"art-bytes", 10, 20, CoverSourceKind::Adjacent, None, 2);
        assert_eq!(a.content_hash, b.content_hash, "the hash is over bytes only");
    }

    #[test]
    fn different_bytes_hash_differently() {
        let a = normalize_cover(b"one", 1, 1, CoverSourceKind::Embedded, None, 1);
        let b = normalize_cover(b"two", 1, 1, CoverSourceKind::Embedded, None, 1);
        assert_ne!(a.content_hash, b.content_hash);
    }

    #[test]
    fn record_carries_dims_kind_and_len() {
        let rec = normalize_cover(
            b"payload",
            640,
            480,
            CoverSourceKind::Imported,
            Some("/pics/art.png".to_string()),
            77,
        );
        assert_eq!(rec.width, 640);
        assert_eq!(rec.height, 480);
        assert_eq!(rec.byte_len, 7);
        assert_eq!(rec.source_kind, "imported");
        assert_eq!(rec.origin_path.as_deref(), Some("/pics/art.png"));
        assert_eq!(rec.created_at, 77);
    }

    #[test]
    fn precedence_folder_over_all() {
        assert_eq!(resolve_track_cover(true, true, true), ResolvedCover::Folder);
        assert_eq!(resolve_track_cover(true, false, false), ResolvedCover::Folder);
    }

    #[test]
    fn precedence_embedded_over_adjacent() {
        assert_eq!(
            resolve_track_cover(false, true, true),
            ResolvedCover::Embedded
        );
    }

    #[test]
    fn precedence_adjacent_then_none() {
        assert_eq!(
            resolve_track_cover(false, false, true),
            ResolvedCover::Adjacent
        );
        assert_eq!(resolve_track_cover(false, false, false), ResolvedCover::None);
    }
}
