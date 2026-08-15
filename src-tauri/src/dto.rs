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
    // The real-case absolute path, for display. NULL on a legacy row until the next scan
    // captures it; identity and grouping stay on the folded `source_path`.
    pub display_path: Option<String>,
    // The edit-layer overrides from `track_edits`, each None when the track has no edit for that
    // field. The grid shows the resolved `edit ?? raw`; the Files-view editor keeps the raw fields
    // above as its revert reference.
    pub title_edit: Option<String>,
    pub artist_edit: Option<String>,
    pub album_edit: Option<String>,
    pub album_artist_edit: Option<String>,
    pub year_edit: Option<i64>,
    pub disc_edit: Option<i64>,
    // The track's managed genres, as vocabulary ids in position order; empty when it carries none.
    pub genre_ids: Vec<i64>,
}

/// One library root shaped for the frontend: the real-case folder path and how many indexed
/// tracks it holds, from a COUNT join over its tracks. Mirrors Root in types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct Root {
    pub id: i64,
    pub path: String,
    pub track_count: i64,
}

/// The blast radius of removing one root, for the counted confirm. `tracks` is how many indexed
/// tracks the root holds; `albums_losing_members` is albums built partly from it that will shrink;
/// `albums_emptied` is albums built entirely from it that will be deleted. Mirrors RootRemovalImpact.
#[derive(Debug, Clone, Serialize)]
pub struct RootRemovalImpact {
    pub tracks: i64,
    pub albums_losing_members: i64,
    pub albums_emptied: i64,
}

/// One vocabulary genre shaped for the frontend: its display name and how many tracks carry it,
/// from a COUNT join over `track_genres`. Genre is per-track and multi-valued behind this managed
/// vocabulary, so a row here is a vocabulary entry, not a per-track membership. Mirrors GenreRow.
#[derive(Debug, Clone, Serialize)]
pub struct GenreRow {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
}

/// The blast radius of removing one genre, for the counted confirm: how many distinct tracks carry
/// it and would lose it when it is deleted. Mirrors GenreRemovalImpact.
#[derive(Debug, Clone, Serialize)]
pub struct GenreRemovalImpact {
    pub tracks: i64,
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
/// empty string); `cover_id` points into the shared `covers` manifest or is None. `kind` is
/// 'album' for a plain album or 'single' for an album-of-one; the frontend splits buckets on it.
#[derive(Debug, Clone, Serialize)]
pub struct AlbumRow {
    pub id: i64,
    pub title: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub genre: Option<String>,
    pub cover_id: Option<i64>,
    pub kind: String,
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
    // The track's genres, as vocabulary ids in position order. Genre is per-track and multi-valued,
    // so this carries each row's own list; empty when the track has none. The album view derives its
    // union from these across members.
    pub genre_ids: Vec<i64>,
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

/// One track's spot in an atomic album layout: its disc and its per-disc position. A None disc_no
/// falls back to disc 1 through the resolver; a None track_no sorts the row last. Named apart from
/// the frontend's own Placement, a membership-at-rest snapshot, to avoid the collision. Mirrors
/// TrackPlacement in types.ts.
#[derive(Debug, Clone, Deserialize)]
pub struct TrackPlacement {
    pub track_id: i64,
    pub disc_no: Option<i64>,
    pub track_no: Option<i64>,
}

/// The Files-view full-edit patch: every editable field of `track_edits` a track carries. A
/// full-set replace, so a None clears its column. This is the raw edit-layer value, NOT resolved
/// against the track's raw scan cache; the frontend already holds the raw fields and resolves
/// `edit ?? raw` itself, the way the album drawer does.
#[derive(Debug, Clone, Deserialize)]
pub struct TrackEditFields {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub disc_no: Option<i64>,
}

/// The Files-view editor's hydration read: a track's raw edit-layer overrides plus its managed
/// genres, so the editor renders the edited value, the revert affordance, and the genre pills. All
/// value fields are None when the track has no `track_edits` row (a pristine track); `genre_ids` is
/// the ordered vocabulary list, empty when it carries none. Mirrors TrackEdit in types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct TrackEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub disc_no: Option<i64>,
    pub genre_ids: Vec<i64>,
}

/// The load-all organize payload: every album (each with its track count) and every membership
/// row. The frontend hydrates its organize state from this in one call.
#[derive(Debug, Clone, Serialize)]
pub struct OrganizationSnapshot {
    pub albums: Vec<AlbumRow>,
    pub membership: Vec<AlbumTrackRow>,
    pub genres: Vec<GenreRow>,
}

/// The export config: where to write and the album layout template. `folder_pattern` is the
/// slash-separated folder tree (empty = flat, no album subfolders); `file_pattern` is the filename,
/// both in the token language. A pre-template caller sending only `destination` leaves both empty
/// and the backend falls back to the shipped default layout. Singles ignore the template.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportConfig {
    pub destination: String,
    #[serde(default)]
    pub folder_pattern: String,
    #[serde(default)]
    pub file_pattern: String,
}

/// The stage a running export is in. `preparing` while the plan is snapshotted and the
/// destination validated, `copying` while files are written, `done` on the single terminal emit.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportPhase {
    Preparing,
    Copying,
    Done,
}

/// A progress tick sent over the invocation's channel. `exported` is monotonic and never exceeds
/// `total`; `errors` counts tracks that failed to write. `done` marks the guaranteed final tick.
#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub phase: ExportPhase,
    pub exported: u32,
    pub total: u32,
    pub errors: u32,
    pub done: bool,
}

/// The fate of one track in an export. `exported` landed (even when its art could not be
/// embedded); `skipped` was never attempted (a missing source); `failed` was attempted and could
/// not be written.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportItemStatus {
    Exported,
    Skipped,
    Failed,
}

/// One row of the export report: which track, in which container folder, and how it landed.
/// `note` carries the plain-language reason for a skip or failure, or a caveat on an exported
/// track (art could not be embedded, or no art was available).
#[derive(Debug, Clone, Serialize)]
pub struct ExportItem {
    pub track_id: i64,
    pub container: String,
    pub status: ExportItemStatus,
    pub note: Option<String>,
}

/// The result of a finished (or cancelled) export. `total` counts every member track considered;
/// `exported`/`skipped`/`errors` partition it. `containers_written` is how many folders were
/// created. `items` is the per-track detail the done screen reads.
#[derive(Debug, Clone, Serialize)]
pub struct ExportSummary {
    pub total: u32,
    pub exported: u32,
    pub skipped: u32,
    pub errors: u32,
    pub cancelled: bool,
    pub containers_written: u32,
    pub items: Vec<ExportItem>,
}

/// The up-front verdict on a picked destination, so the UI can gate and warn before a run.
/// `inside_workspace` is the hard refusal (a dest overlapping any library root); `non_empty` is
/// the soft warn (a destination that already holds files); `writable` proves a probe write
/// succeeded. `ok` is true only when the destination is usable: writable and not inside any root.
#[derive(Debug, Clone, Serialize)]
pub struct DestinationCheck {
    pub ok: bool,
    pub inside_workspace: bool,
    pub non_empty: bool,
    pub writable: bool,
}

/// The fields recovered from one track's path by the filename extractor: the inverse of the export
/// tokens. Every field is None when its token was absent from the pattern, a numeric token whose
/// text will not parse, or the whole row is unmatched. Mirrors ExtractedFields in types.ts.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ExtractedFields {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i64>,
    pub disc_no: Option<i64>,
    pub track_no: Option<i64>,
    pub genre: Option<String>,
}

/// One track's extraction preview: whether its path matched the pattern and the fields that came
/// out. An unmatched row carries `matched: false` and an all-None `fields`, so the frontend can grey
/// it in the same list. Mirrors ExtractRow in types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct ExtractRow {
    pub track_id: i64,
    pub matched: bool,
    pub fields: ExtractedFields,
}

/// The tally of an extract-apply run. `applied` is how many tracks had at least one field written;
/// `unmatched` is how many did not match the pattern; `track_no_skipped_loose` counts matched loose
/// tracks whose extracted track number was skipped because a track number is album-scoped. Mirrors
/// ExtractResult in types.ts.
#[derive(Debug, Clone, Serialize)]
pub struct ExtractResult {
    pub applied: i64,
    pub unmatched: i64,
    pub track_no_skipped_loose: i64,
}
