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
    // NULL while the file is present; a timestamp of the scan that first found it gone.
    pub missing_at: Option<i64>,
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
/// `missing`/`returned` are rows flagged gone and rows cleared as returned this pass; `removed`
/// is reserved for a future purge command and reads 0 during a scan.
#[derive(Debug, Clone, Serialize)]
pub struct ScanSummary {
    pub total: u32,
    pub seen: u32,
    pub inserted: u32,
    pub updated: u32,
    pub skipped: u32,
    pub removed: u32,
    pub missing: u32,
    pub returned: u32,
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

/// The thumbnail size a cover command is asked for. `thumb` is the small candidate-list size,
/// `detail` the larger peek size. Each maps to a bounded longest edge in the cover pipeline.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverSize {
    Thumb,
    Detail,
}

/// Where a resolved cover's art came from, surfaced to the frontend for its provenance line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverSource {
    Embedded,
    Adjacent,
    Imported,
}

/// The single resolved cover for a track: a cache-file path the frontend wraps with
/// `convertFileSrc`, the source art's pixel dimensions, and where it came from.
#[derive(Debug, Clone, Serialize)]
pub struct CoverRef {
    pub path: String,
    pub width: i64,
    pub height: i64,
    pub source: CoverSource,
}

/// One selectable art source for the cover picker: a generated thumb path plus its provenance.
/// `origin_path` is the on-disk file the art was read from (the audio file for embedded art,
/// the image file for an adjacent one), used to label the source.
#[derive(Debug, Clone, Serialize)]
pub struct CoverCandidate {
    pub source: CoverSource,
    pub origin_path: Option<String>,
    pub path: String,
    pub width: i64,
    pub height: i64,
}

/// One album shaped for the frontend, with `track_count` from a COUNT join over its membership.
/// Nullable metadata is `Option` (NULL = unset, resolved to a display default in the UI, never an
/// empty string); `cover_id` points into the shared `covers` manifest or is None.
#[derive(Debug, Clone, Serialize)]
pub struct AlbumRow {
    pub id: i64,
    pub title: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub cover_id: Option<i64>,
    pub track_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One membership row for the album drawer: the immutable source cache and the per-track override
/// side by side, so the frontend resolves `override ?? raw` for display itself. The source fields
/// join in from the track's own row; the override and numbering live on `album_tracks`.
#[derive(Debug, Clone, Serialize)]
pub struct AlbumTrackRow {
    pub album_id: i64,
    pub track_id: i64,
    pub source_path: String,
    pub filename: String,
    pub duration_secs: Option<f64>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub raw_title: Option<String>,
    pub raw_artist: Option<String>,
    pub title_override: Option<String>,
    pub artist_override: Option<String>,
    pub has_embedded_cover: Option<bool>,
    pub missing_at: Option<i64>,
}

/// The album-metadata patch: a full-set replace of the four editable fields. The frontend sends
/// the whole current set on commit, so a None clears its column to NULL.
#[derive(Debug, Clone, Deserialize)]
pub struct AlbumFields {
    pub title: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
}

/// The per-track override patch for one membership row: a full-set replace of its overrides and
/// numbering. As with album fields, a None clears its column.
#[derive(Debug, Clone, Deserialize)]
pub struct TrackOverride {
    pub title_override: Option<String>,
    pub artist_override: Option<String>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
}

/// The load-all organize payload: every album (each with its track count) and every membership
/// row. The frontend hydrates its organize state from this in one call.
#[derive(Debug, Clone, Serialize)]
pub struct OrganizationSnapshot {
    pub albums: Vec<AlbumRow>,
    pub membership: Vec<AlbumTrackRow>,
}
