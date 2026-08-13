/*
 * Domain types for a scanned track. RawTags is the unparsed tag set read from one file;
 * TrackRecord is the normalized row that lands in the `tracks` table. The two are split so
 * the messy input and the clean, persistable output never get confused: normalize.rs is the
 * only bridge between them.
 */

/// The raw tag set read from a single file, before any parsing or cleanup. Every field is
/// optional because a file may carry none of them, and the numeric fields stay strings here
/// because tags routinely hold junk like "3/12" or "1997-01-01" that only means something
/// after normalization.
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
}

/// A normalized, persistable row matching the `tracks` schema one-to-one. Absent tags are
/// None (never an empty string), numerics are parsed integers, `source_path` is the canonical
/// dedup key and `ext` is lowercased. The DB assigns `id`, so it is not carried here.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackRecord {
    pub source_path: String,
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
    pub scanned_at: i64,
}
