/*
 * Domain types for a scanned track. RawTags is the unparsed tag set read from one file;
 * TrackRecord is the normalized row that lands in the `tracks` table. The two are split so
 * the messy input and the clean, persistable output never get confused: normalize.rs is the
 * only bridge between them. CoverRecord is the sibling persistable row for the `covers`
 * manifest, filled by the covers module's normalize_cover.
 */

/// The raw tag set read from a single file, before any parsing or cleanup. Every field is
/// optional because a file may carry none of them, and the numeric fields stay strings here
/// because tags routinely hold junk like "3/12" or "1997-01-01" that only means something
/// after normalization. `has_embedded_cover` is Some once a file has been examined for art,
/// None only on a default set that no reader has filled.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub track_no: Option<String>,
    pub disc_no: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub duration_secs: Option<f64>,
    pub has_embedded_cover: Option<bool>,
}

/// A normalized, persistable row matching the `tracks` schema one-to-one. Absent tags are
/// None (never an empty string), numerics are parsed integers, `source_path` is the canonical
/// dedup key and `ext` is lowercased. `display_path` is the same path with its real case kept,
/// for display. The DB assigns `id`, so it is not carried here. `has_embedded_cover` is
/// tri-state: None means the file was never examined for art (the drain sentinel), Some(false)
/// examined with none, Some(true) examined with art.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackRecord {
    pub source_path: String,
    pub display_path: String,
    pub filename: String,
    pub ext: String,
    pub size_bytes: i64,
    pub mtime: i64,
    pub duration_secs: Option<f64>,
    pub raw_title: Option<String>,
    pub raw_artist: Option<String>,
    pub raw_album: Option<String>,
    pub raw_album_artist: Option<String>,
    pub raw_track_no: Option<i64>,
    pub raw_disc_no: Option<i64>,
    pub raw_year: Option<i64>,
    pub raw_genre: Option<String>,
    pub has_embedded_cover: Option<bool>,
    pub scanned_at: i64,
}

/// A normalized, persistable row matching the `covers` schema. `content_hash` is the blake3
/// hex over the raw art bytes and is both the dedup key and the on-disk thumbnail key
/// (`<content_hash>_<size>.jpg`), so no path column is stored. `source_kind` is one of
/// "embedded", "adjacent", "imported". Built only by covers::normalize_cover; the DB assigns
/// `id`, so it is not carried here.
#[derive(Debug, Clone, PartialEq)]
pub struct CoverRecord {
    pub content_hash: String,
    pub source_kind: String,
    pub origin_path: Option<String>,
    pub width: i64,
    pub height: i64,
    pub byte_len: i64,
    pub created_at: i64,
}
