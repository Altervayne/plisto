/*
 * The IPC data types shared across the command boundary. Every struct here has a one-to-one
 * twin in the frontend's types.ts; the two move together. Serialized field names are the
 * snake_case Rust names verbatim, so the frontend reads the same keys the DB stores.
 */

// -- Library Imports --
use serde::{Deserialize, Serialize};

/// One grid row: a `tracks` record shaped for the frontend. Nullable columns are `Option`,
/// which serialize to `null`. `id` is the row's primary key.
#[derive(Debug, Clone, Serialize)]
pub struct TrackRow {
    pub id: i64,
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

/// The stage a running scan is in. `enumerating` while the folder is walked, `reading` while
/// tags are parsed, `done` on the single terminal emit.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanPhase {
    Enumerating,
    Reading,
    Done,
}

/// A progress tick sent over the invocation's channel. `scanned` is monotonic and never
/// exceeds `total`; the frontend takes the max. `done` marks the guaranteed final tick.
#[derive(Debug, Clone, Serialize)]
pub struct ScanProgress {
    pub phase: ScanPhase,
    pub scanned: u32,
    pub total: u32,
    pub errors: u32,
    pub done: bool,
}

/// The result of a finished (or cancelled) scan. `seen` is how many files were actually
/// processed; on a full pass it equals `total`, on a cancel it is lower. `errors` counts
/// files whose tags could not be read but were still indexed from their path and stats.
#[derive(Debug, Clone, Serialize)]
pub struct ScanSummary {
    pub total: u32,
    pub seen: u32,
    pub inserted: u32,
    pub updated: u32,
    pub skipped: u32,
    pub removed: u32,
    pub errors: u32,
    pub cancelled: bool,
}

/// Sort direction for `list_tracks`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortDir {
    Asc,
    Desc,
}

/// A sort request from the frontend. `column` is validated against an explicit allowlist
/// before it reaches any SQL, so it can never inject.
#[derive(Debug, Clone, Deserialize)]
pub struct SortSpec {
    pub column: String,
    pub dir: SortDir,
}

/// The `list_tracks` payload: the requested window of rows plus the full count for the
/// current filter, ignoring offset and limit.
#[derive(Debug, Clone, Serialize)]
pub struct ListTracksResponse {
    pub rows: Vec<TrackRow>,
    pub total: u32,
}
