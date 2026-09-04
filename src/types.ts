/*
 * The IPC contract, mirrored from the Rust structs in src-tauri. Keep these in
 * lockstep with the backend: a field added there is added here in the same pass.
 */

/** Backend identity, returned by the `app_info` command. Mirrors AppInfo in lib.rs. */
export interface AppInfo {
  name: string;
  version: string;
}

/** One grid row: a scanned track. Mirrors TrackRow in dto.rs; nullable columns are null. */
export interface TrackRow {
  id: number;
  source_path: string;
  filename: string;
  ext: string;
  size_bytes: number;
  mtime: number;
  duration_secs: number | null;
  raw_title: string | null;
  raw_artist: string | null;
  raw_album: string | null;
  raw_album_artist: string | null;
  raw_track_no: number | null;
  raw_disc_no: number | null;
  raw_year: number | null;
  raw_genre: string | null;
  scanned_at: number;
  missing_at: number | null;
  display_path: string | null;
  title_edit: string | null;
  artist_edit: string | null;
  album_edit: string | null;
  album_artist_edit: string | null;
  year_edit: number | null;
  disc_edit: number | null;
  genre_ids: number[];
}

/** The stage a running scan is in. Mirrors ScanPhase in dto.rs. */
export type ScanPhase = 'enumerating' | 'reading' | 'done';

/** A progress tick over the scan channel. `scanned` is monotonic. Mirrors ScanProgress. */
export interface ScanProgress {
  phase: ScanPhase;
  scanned: number;
  total: number;
  errors: number;
  done: boolean;
}

/** The counts from a finished or cancelled scan. Mirrors ScanSummary in dto.rs. */
export interface ScanSummary {
  total: number;
  seen: number;
  inserted: number;
  updated: number;
  skipped: number;
  removed: number;
  missing: number;
  returned: number;
  errors: number;
  cancelled: boolean;
}

/** One library root: its folder path and indexed track count. Mirrors Root in dto.rs. */
export interface Root {
  id: number;
  path: string;
  track_count: number;
}

/** The blast radius of removing a root, for the counted confirm. Mirrors RootRemovalImpact. */
export interface RootRemovalImpact {
  tracks: number;
  albums_losing_members: number;
  albums_emptied: number;
}

/**
 * One vocabulary genre: its display name and how many tracks carry it. Genre is per-track and
 * multi-valued behind this managed vocabulary. Mirrors GenreRow in dto.rs.
 */
export interface GenreRow {
  id: number;
  name: string;
  track_count: number;
}

/** The blast radius of deleting a genre: how many distinct tracks lose it. Mirrors GenreRemovalImpact. */
export interface GenreRemovalImpact {
  tracks: number;
}

/** Sort direction for `list_tracks`. Mirrors SortDir in dto.rs. */
export type SortDir = 'asc' | 'desc';

/** A sort request for `list_tracks`. Mirrors SortSpec in dto.rs. */
export interface SortSpec {
  column: string;
  dir: SortDir;
}

/** The `list_tracks` payload: the window of rows plus the full filtered count. */
export interface ListTracksResponse {
  rows: TrackRow[];
  total: number;
}

/** The thumbnail size a cover command is asked for. Mirrors CoverSize in dto.rs. */
export type CoverSize = 'thumb' | 'detail';

/** Where a cover's art came from, for the provenance line. Mirrors CoverSource in dto.rs. */
export type CoverSource = 'embedded' | 'adjacent' | 'imported';

/** The single resolved cover for a track. `path` is a cache file wrapped with convertFileSrc. */
export interface CoverRef {
  path: string;
  width: number;
  height: number;
  source: CoverSource;
}

/** One selectable art source for the cover picker. Mirrors CoverCandidate in dto.rs. */
export interface CoverCandidate {
  source: CoverSource;
  origin_path: string | null;
  path: string;
  width: number;
  height: number;
}

/**
 * One album's brief identity for a discovered folder that resolves to exactly one album: its id,
 * title (null = untitled), and whether it already carries a cover. Mirrors AlbumBrief in dto.rs.
 */
export interface AlbumBrief {
  id: number;
  title: string | null;
  has_cover: boolean;
}

/**
 * One folder of loose images found by the covers sweep: the real-case folder path and leaf name, the
 * image paths inside it, whether the folder still needs a cover, the album it resolves to (only when
 * exactly one), and its non-missing track count. Streamed one per folder. Mirrors ImageFolderGroup.
 */
export interface ImageFolderGroup {
  folder_path: string;
  folder_name: string;
  images: string[];
  needs_cover: boolean;
  album: AlbumBrief | null;
  track_count: number;
}

/** The bucket an album row belongs to: a plain album, or an album-of-one single. Mirrors the Rust `kind`. */
export type AlbumKind = 'album' | 'single';

/** One album with its track count. Mirrors AlbumRow in dto.rs; nullable metadata is null. */
export interface AlbumRow {
  id: number;
  title: string | null;
  album_artist: string | null;
  year: number | null;
  genre: string | null;
  cover_id: number | null;
  kind: AlbumKind;
  track_count: number;
  created_at: number;
  updated_at: number;
}

/**
 * One membership row for the album drawer: raw source cache and per-track override side by side,
 * so the UI resolves `override ?? raw` itself. Mirrors AlbumTrackRow in dto.rs.
 */
export interface AlbumTrackRow {
  album_id: number;
  track_id: number;
  source_path: string;
  filename: string;
  duration_secs: number | null;
  track_no: number | null;
  disc_no: number | null;
  raw_title: string | null;
  raw_artist: string | null;
  title_override: string | null;
  artist_override: string | null;
  has_embedded_cover: boolean | null;
  missing_at: number | null;
  keep_own_cover: boolean;
  genre_ids: number[];
}

/** The album-metadata patch: a full-set replace, a null clears a column. Mirrors AlbumFields. */
export interface AlbumFields {
  title: string | null;
  album_artist: string | null;
  year: number | null;
  genre: string | null;
}

/** The per-track override patch: a full-set replace, a null clears a column. Mirrors TrackOverride. */
export interface TrackOverride {
  title_override: string | null;
  artist_override: string | null;
  track_no: number | null;
  disc_no: number | null;
}

/**
 * One track's spot in an atomic album layout: its disc and its per-disc position. A null disc_no
 * falls back to disc 1; a null track_no sorts the row last. Named apart from the store's own
 * Placement, a membership-at-rest snapshot. Mirrors TrackPlacement in dto.rs.
 */
export interface TrackPlacement {
  track_id: number;
  disc_no: number | null;
  track_no: number | null;
}

/**
 * The Files-view full-edit patch: every editable `track_edits` field, a full-set replace where a
 * null clears a column. The raw edit-layer value, not resolved against raw. Mirrors TrackEditFields.
 */
export interface TrackEditFields {
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  year: number | null;
  disc_no: number | null;
}

/**
 * The bulk tag patch over a multi-track selection: one shared value per set-field. Each field is
 * tri-state - absent leaves the column untouched, an empty string clears it, a value sets it. Title
 * and disc are deliberately absent, being per-track. `year` rides as text so an empty string can
 * carry the clear signal; the backend parses it. Mirrors BulkSetFields in dto.rs.
 */
export interface BulkSetFields {
  artist?: string;
  album?: string;
  album_artist?: string;
  year?: string;
}

/** The tally of a bulk-edit run: how many selected tracks were written. Mirrors BulkEditResult. */
export interface BulkEditResult {
  edited: number;
}

/** The tally of a force-apply of album fields onto its members: how many were written. Mirrors AppliedResult. */
export interface AppliedResult {
  tracks: number;
}

/** One title write in a clean-titles apply: a track and its sanitized title. Mirrors TrackTitle in dto.rs. */
export interface TrackTitle {
  track_id: number;
  title: string;
}

/**
 * The Files-view editor's hydration read: a track's raw edit-layer overrides plus its ordered
 * genres. All value fields are null when the track has no edit row; `genre_ids` is empty when it
 * carries none. Raw edit values, resolved against raw by the UI itself. Mirrors TrackEdit in dto.rs.
 */
export interface TrackEdit {
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  year: number | null;
  disc_no: number | null;
  genre_ids: number[];
}

/**
 * One track's resolved title and artist for a now-playing surface: the edit-layer value over the raw
 * scan value, each null when neither layer holds one. A satellite webview reads this by id to name
 * the current track without the main window's library store. Mirrors TrackDisplay in dto.rs.
 */
export interface TrackDisplay {
  title: string | null;
  artist: string | null;
}

/** The load-all organize payload. Mirrors OrganizationSnapshot in dto.rs. */
export interface OrganizationSnapshot {
  albums: AlbumRow[];
  membership: AlbumTrackRow[];
  genres: GenreRow[];
}

/**
 * The export config: the destination plus the album layout template. `folder_pattern` is the
 * slash-separated folder tree (empty = flat, no album subfolders); `file_pattern` is the filename,
 * both in the token language. Singles ignore the template. Mirrors ExportConfig in dto.rs.
 */
export interface ExportConfig {
  destination: string;
  folder_pattern: string;
  file_pattern: string;
  // Device mode: false drops a fresh dated snapshot folder, true merges into the picked device folder
  // in place (incremental update). Ignored for a folder export.
  device_in_place?: boolean;
  // Set only for a device export: the picked device target the staged library transfers onto. Absent,
  // the export writes straight into `destination`.
  device?: DeviceTarget;
  // A scoped export's explicit album/single id set: present narrows the plan to those containers,
  // absent exports every album/single (the general export).
  album_ids?: number[];
}

/** The stage a running export is in. Mirrors ExportPhase in dto.rs. */
export type ExportPhase = 'preparing' | 'copying' | 'transferring' | 'done';

/** A progress tick over the export channel. `exported` is monotonic. Mirrors ExportProgress. */
export interface ExportProgress {
  phase: ExportPhase;
  exported: number;
  total: number;
  errors: number;
  done: boolean;
}

/** How one track landed in an export. Mirrors ExportItemStatus in dto.rs. */
export type ExportItemStatus = 'exported' | 'skipped' | 'failed';

/** One report row: which track, in which container, how it landed, and why. Mirrors ExportItem. */
export interface ExportItem {
  track_id: number;
  container: string;
  status: ExportItemStatus;
  note: string | null;
}

/** The result of a finished or cancelled export. Mirrors ExportSummary in dto.rs. */
export interface ExportSummary {
  total: number;
  exported: number;
  skipped: number;
  errors: number;
  cancelled: boolean;
  containers_written: number;
  items: ExportItem[];
}

/**
 * The app-global snapshot of the current export, read by the tray popup when it opens mid-run.
 * `running` spans the worker's first tick to its terminal event; `progress` is the latest tick while
 * running, null otherwise. Mirrors ExportStatus in dto.rs.
 */
export interface ExportStatus {
  running: boolean;
  progress: ExportProgress | null;
}

/** The up-front verdict on a picked destination. Mirrors DestinationCheck in dto.rs. */
export interface DestinationCheck {
  ok: boolean;
  inside_workspace: boolean;
  non_empty: boolean;
  writable: boolean;
}

/** A picked MTP/device export target. No filesystem path - the durable ref is the shell PIDL, hex-encoded. Mirrors DeviceTarget in dto.rs. */
export interface DeviceTarget {
  device_name: string;
  display: string;
  pidl: string;
}

/** A chosen export destination: a real folder path, or a connected device. */
export type ExportTarget =
  | { kind: 'folder'; path: string }
  | { kind: 'device'; target: DeviceTarget };

/**
 * The fields one filename parsed into, under the active pattern. Every field is optional: a token the
 * pattern never captured, or captured empty, is absent. Numbers stay numbers. Mirrors ExtractedFields.
 */
export interface ExtractedFields {
  title?: string;
  artist?: string;
  album?: string;
  album_artist?: string;
  year?: number;
  disc_no?: number;
  track_no?: number;
  genre?: string;
}

/**
 * One preview row: a track and what its filename parsed to. `matched` is false for a filename the
 * pattern did not fit or a track that is not indexed, and `fields` is then empty. Mirrors ExtractRow.
 */
export interface ExtractRow {
  track_id: number;
  matched: boolean;
  fields: ExtractedFields;
}

/**
 * One playlist with its live slot count. A null name reads as the untitled default; `description` is
 * its optional blurb, null when unset. `cover_id` points into the shared covers manifest or is null,
 * the way `albums.cover_id` does. Mirrors PlaylistRow in dto.rs.
 */
export interface PlaylistRow {
  id: number;
  name: string | null;
  description: string | null;
  cover_id: number | null;
  created_at: number;
  updated_at: number;
  track_count: number;
}

/**
 * One slot in a playlist: a track at a position. `id` is the SLOT identity, not the track - a playlist
 * may hold the same track more than once, so the slot id is what keys, removes, and reorders a row.
 * `title`/`artist` are the track_edits values; `raw_title`/`raw_artist` the scanned tags. Mirrors
 * PlaylistTrackRow in dto.rs.
 */
export interface PlaylistTrackRow {
  id: number;
  playlist_id: number;
  track_id: number;
  position: number;
  source_path: string;
  display_path: string | null;
  filename: string;
  duration_secs: number | null;
  raw_title: string | null;
  raw_artist: string | null;
  title: string | null;
  artist: string | null;
  missing_at: number | null;
}

/** The load-all playlists payload: every playlist and every slot across them. Mirrors PlaylistSnapshot. */
export interface PlaylistSnapshot {
  playlists: PlaylistRow[];
  tracks: PlaylistTrackRow[];
}

/**
 * The result of a playlist file export - the plain .m3u and the rich .m3u8. `written` counts the tracks
 * that made it into the file; `skipped_missing` the slots dropped because their source is gone. The folder
 * export reports the fuller ExportSummary instead. Mirrors PlaylistM3uSummary in dto.rs.
 */
export interface PlaylistM3uSummary {
  written: number;
  skipped_missing: number;
}

/**
 * The outcome of an apply: how many tracks took a write, how many filenames did not match, and how
 * many track numbers were dropped because their track is loose (no album position). Mirrors ExtractResult.
 */
export interface ExtractResult {
  applied: number;
  unmatched: number;
  track_no_skipped_loose: number;
}

/** The engine's repeat mode: no repeat, repeat the queue, or repeat the current track. Mirrors RepeatMode in audio/mod.rs. */
export type RepeatMode = 'off' | 'all' | 'one';

/** The number of spectrum bands the engine emits per frame. Mirrors BAND_COUNT in audio/engine.rs. */
export const BAND_COUNT = 24;

/** One spectrum frame: per-band levels in 0..1, already normalized by the engine. The `player:spectrum` payload. */
export type SpectrumBands = number[];

/**
 * A user-facing player notice, the `player:error` payload: a file that would not play, a lost audio
 * output, or a pinned device gone so playback fell back to the system default. Mirrors PlayerNotice
 * in audio/mod.rs.
 */
export type PlayerNotice = 'file' | 'output' | 'device_fallback';

/**
 * The player's live snapshot: what is playing, where the playhead sits, and the queue cursor. The
 * throttled `player:status` event and `get_player_status` both carry it. `track_id` is null when the
 * engine is stopped. Mirrors PlayerStatus in audio/mod.rs.
 */
export interface PlayerStatus {
  playing: boolean;
  track_id: number | null;
  position_secs: number;
  duration_secs: number;
  volume: number;
  repeat: RepeatMode;
  queue_index: number;
  queue_len: number;
  shuffle: boolean;
  output_device: string | null;
}

/**
 * Where the current queue was launched from, captured on the frontend when play fires - the engine is
 * source-agnostic, so the store records the origin the "playing from" line reads. An album or playlist
 * carries its id and resolved label; the flat library views carry only their kind; a lone track played
 * on its own carries the track id and its title.
 */
export type PlaybackSource =
  | { kind: "album"; id: number; label: string }
  | { kind: "playlist"; id: number; label: string }
  | { kind: "files" }
  | { kind: "singles" }
  | { kind: "unsorted" }
  | { kind: "single"; id: number; label: string };

/**
 * One selectable output device: its name and whether it is the current OS default. The settings
 * picker's "System default" entry is synthetic and carries no name. Mirrors OutputDeviceInfo in
 * audio/mod.rs.
 */
export interface OutputDeviceInfo {
  name: string;
  is_default: boolean;
}

// ---- Splicer / cropper ----

/**
 * One segment to cut from a source file: a half-open frame range [start_frame, end_frame) and the
 * tags to write onto the cut. `track_no` numbers the segment. Mirrors Segment in dto.rs.
 */
export interface Segment {
  start_frame: number;
  end_frame: number;
  title: string | null;
  artist: string | null;
  track_no: number | null;
}

/** What a segment cut does when its filename already exists. Mirrors CollisionPolicy in dto.rs. */
export type CollisionPolicy = 'skip' | 'overwrite' | 'rename';

/**
 * A splice job: the source file, the ordered segments, the destination folder, the filename naming
 * pattern, and the collision policy. `keep_source_tags` picks the tagging: false (the splitter) overlays
 * each segment's per-track fields onto the inherited source tag; true (the cropper) keeps the source tag
 * verbatim, the trimmed file being the same track. Mirrors SpliceJob in dto.rs.
 */
export interface SpliceJob {
  source_path: string;
  segments: Segment[];
  destination: string;
  naming_pattern: string;
  collision: CollisionPolicy;
  keep_source_tags: boolean;
}

/** One waveform bucket: the lowest and highest mono sample it spans. Mirrors Peak in audio/peaks.rs. */
export interface Peak {
  min: number;
  max: number;
}

/** A contiguous run of silence: `start_frame` inclusive, `end_frame` exclusive. Mirrors SilenceSpan. */
export interface SilenceSpan {
  start_frame: number;
  end_frame: number;
}

/**
 * The full analysis of a source file: the waveform peaks, the silence spans, and the stream shape.
 * `total_frames` and `duration_secs` size the timeline. Mirrors WaveformAnalysis in dto.rs.
 */
export interface WaveformAnalysis {
  peaks: Peak[];
  silence: SilenceSpan[];
  sample_rate: number;
  channels: number;
  total_frames: number;
  duration_secs: number;
}

/** The stage a running splice is in. Mirrors SplicePhase in dto.rs. */
export type SplicePhase = 'preparing' | 'cutting' | 'done';

/** A progress tick over the splice channel. `completed` is monotonic. Mirrors SpliceProgress. */
export interface SpliceProgress {
  phase: SplicePhase;
  completed: number;
  total: number;
  errors: number;
  done: boolean;
}

/** A progress tick over the analysis channel: frames decoded of the total. Mirrors AnalyzeProgress. */
export interface AnalyzeProgress {
  done_frames: number;
  total_frames: number;
}

/** How one segment landed in a splice. Mirrors SpliceItemStatus in dto.rs. */
export type SpliceItemStatus = 'written' | 'skipped' | 'failed';

/** One report row: which segment, where it landed, and how. Mirrors SpliceItem in dto.rs. */
export interface SpliceItem {
  index: number;
  output_path: string | null;
  status: SpliceItemStatus;
  note: string | null;
}

/** The result of a finished or cancelled splice. Mirrors SpliceReport in dto.rs. */
export interface SpliceReport {
  total: number;
  written: number;
  errors: number;
  cancelled: boolean;
  items: SpliceItem[];
}

/**
 * One parsed cue sheet track: its number, its title and performer when stated, and its start time in
 * seconds. Mirrors CueTrack in dto.rs.
 */
export interface CueTrack {
  number: number;
  title: string | null;
  performer: string | null;
  start_secs: number;
}

/** A parsed cue sheet: the disc performer when stated, and the tracks in file order. Mirrors CueSheet. */
export interface CueSheet {
  performer: string | null;
  tracks: CueTrack[];
}
