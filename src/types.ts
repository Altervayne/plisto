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
  /** Unreadable files on record after the pass, whenever each one first failed. */
  issues: number;
  cancelled: boolean;
  /** Roots that could not be read this pass; their tracks were left untouched. */
  offline_roots: number[];
  /** Files still being written, left unindexed until a later pass. */
  deferred: number;
}

/** How a root is kept current. Mirrors RootWatchMode in dto.rs. */
export type RootWatchMode = 'watching' | 'polling' | 'offline';

/** One root's watch mode, the `library:roots-state` payload item. Mirrors RootWatchState. */
export interface RootWatchState {
  id: number;
  mode: RootWatchMode;
}

/** The library-sync snapshot from `get_library_sync_status`. Mirrors LibrarySyncStatus. */
export interface LibrarySyncStatus {
  enabled: boolean;
  running: boolean;
  scanned: number;
  total: number;
  roots: RootWatchState[];
}

/** The `library:sync` tick: a background session's running totals. Mirrors LibrarySyncTick. */
export interface LibrarySyncTick {
  running: boolean;
  scanned: number;
  total: number;
  deferred: number;
}

/**
 * How the present tracks stand for loudness levelling, from `loudness_coverage` and the `loudness:progress`
 * event. The four buckets sum to `total`. Mirrors LoudnessCoverage in dto.rs.
 */
export interface LoudnessCoverage {
  total: number;
  tagged: number;
  measured: number;
  unmeasurable: number;
  pending: number;
}

/** The `library:delta` payload: changed row ids, or a reload when too many changed. Mirrors LibraryDelta. */
export type LibraryDelta = { ids: number[] } | { reload: true };

/** The `library:summary` payload: one background session's totals. Mirrors LibrarySyncSummary. */
export interface LibrarySyncSummary {
  inserted: number;
  updated: number;
  missing: number;
  returned: number;
  deferred: number;
  errors: number;
  /** Unreadable files on record after the session. */
  issues: number;
  /** Issues that appeared or changed reason during the session. */
  new_issues: number;
  offline_roots: number[];
}

/** What a scan could not read: a file's tags, a file's stat, or a whole folder. Mirrors ScanIssueKind. */
export type ScanIssueKind = 'tags' | 'stat' | 'folder';

/** Why a read failed, a closed set the UI words. Mirrors ScanIssueReason in scan/issues.rs. */
export type ScanIssueReason =
  | 'access_denied'
  | 'in_use'
  | 'path_too_long'
  | 'corrupt_or_unsupported'
  | 'disk_error'
  | 'other';

/** One recorded read failure. `track_id` is set for kind 'tags' only. Mirrors ScanIssue in dto.rs. */
export interface ScanIssue {
  id: number;
  path: string;
  root_id: number;
  track_id: number | null;
  kind: ScanIssueKind;
  reason: ScanIssueReason;
  /** The raw error text, sanitized and capped. */
  detail: string;
  first_seen: number;
  last_seen: number;
}

/**
 * One page of the issue list. `total` follows the reason filter; `by_reason` counts the whole table and
 * omits reasons with no rows. Mirrors ScanIssuePage in dto.rs.
 */
export interface ScanIssuePage {
  total: number;
  rows: ScanIssue[];
  by_reason: Partial<Record<ScanIssueReason, number>>;
}

/**
 * A tick of a running retry: `total` rows were selected, `done` of them are finished. Mirrors
 * ScanIssueRetryProgress in dto.rs.
 */
export interface ScanIssueRetryProgress {
  done: number;
  total: number;
}

/** The outcome of a retry. Mirrors ScanIssueRetryResult in dto.rs. */
export interface ScanIssueRetryResult {
  retried: number;
  cleared: number;
  remaining: number;
}

/** One library root: its folder path, indexed track count and gone-track count. Mirrors Root in dto.rs. */
export interface Root {
  id: number;
  path: string;
  track_count: number;
  missing_count: number;
}

/** The blast radius of removing a root, for the counted confirm. Mirrors RootRemovalImpact. */
export interface RootRemovalImpact {
  tracks: number;
  albums_losing_members: number;
  albums_emptied: number;
  playlist_entries: number;
  plays: number;
}

/** Why a relocate was refused before anything changed. Mirrors RelocateRefusal in dto.rs. */
export type RelocateRefusal =
  | { code: 'same' }
  | { code: 'overlap'; other: string }
  | { code: 'unreadable' }
  | { code: 'no_match'; sampled: number; matched: number }
  | { code: 'inconclusive' }
  | { code: 'failed'; message: string };

/**
 * What picking a new folder for a root would do. A move is verified by a stat sample (`partial` is the
 * backend's verdict); a merge is exact, folding an already-indexed root into this one. Mirrors RelocatePreview.
 */
export type RelocatePreview =
  | { kind: 'move'; total: number; sampled: number; matched: number; partial: boolean }
  | {
      kind: 'merge';
      other_id: number;
      other_tracks: number;
      total: number;
      matched: number;
      albums_replaced: number;
      partial: boolean;
    }
  | { kind: 'refused'; reason: RelocateRefusal };

/** An offline or all-missing root whose files look to be under a freshly picked folder. Mirrors RelinkCandidate. */
export interface RelinkCandidate {
  root_id: number;
  path: string;
  total: number;
  sampled: number;
  matched: number;
  partial: boolean;
}

/** The result of a relocate: done with the rescan summary, or refused with nothing changed. Mirrors RelocateOutcome. */
export type RelocateOutcome =
  | { kind: 'done'; summary: ScanSummary; merged: boolean; albums_replaced: number }
  | { kind: 'refused'; reason: RelocateRefusal };

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

/** The tally of a gone-track purge: rows dropped and albums the sweep emptied. Mirrors PurgeSummary. */
export interface PurgeSummary {
  removed: number;
  albums_emptied: number;
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
export type CoverSize = 'thumb' | 'grid' | 'detail';

/** Where a cover's art came from, for the provenance line. Mirrors CoverSource in dto.rs. */
export type CoverSource = 'embedded' | 'adjacent' | 'imported';

/** The single resolved cover for a track. `path` is a cache file wrapped with convertFileSrc. */
export interface CoverRef {
  path: string;
  width: number;
  height: number;
  source: CoverSource;
}

/** One album's entry in a batched cover read. Mirrors AlbumCoverEntry in album_covers.rs. */
export interface AlbumCoverEntry {
  album_id: number;
  cover: CoverRef | null;
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

/** Where an albums-from-tags plan files its tracks: a new album or an existing one. Mirrors TagAlbumTarget. */
export type TagAlbumTarget =
  | { kind: 'new'; fields: AlbumFields }
  | { kind: 'existing'; album_id: number };

/** One group of an albums-from-tags batch: loose tracks in play order and their target. Mirrors TagAlbumPlan. */
export interface TagAlbumPlan {
  track_ids: number[];
  target: TagAlbumTarget;
}

/** One membership an albums-from-tags batch wrote. Mirrors TagAlbumMember in dto.rs. */
export interface TagAlbumMember {
  track_id: number;
  track_no: number;
}

/** A new album an albums-from-tags batch created: its whole row and members. Mirrors TagAlbumCreated. */
export interface TagAlbumCreated {
  id: number;
  title: string | null;
  album_artist: string | null;
  year: number | null;
  genre: string | null;
  cover_id: number | null;
  kind: AlbumKind;
  created_at: number;
  updated_at: number;
  members: TagAlbumMember[];
}

/** An existing album a batch appended to, with its updated_at on either side. Mirrors TagAlbumExtended. */
export interface TagAlbumExtended {
  album_id: number;
  members: TagAlbumMember[];
  prev_updated_at: number;
  updated_at: number;
}

/**
 * Everything one albums-from-tags batch wrote. Held opaque by the frontend and sent back as-is, so the
 * batch's undo and redo replay exactly these rows. Mirrors TagAlbumReceipt in dto.rs.
 */
export interface TagAlbumReceipt {
  created: TagAlbumCreated[];
  extended: TagAlbumExtended[];
}

/** Two tracks marked as not duplicates, lower id first. Mirrors DismissedPair in dto.rs. */
export interface DismissedPair {
  track_lo: number;
  track_hi: number;
}

/** A playlist slot or play row a merge re-pointed, with the track it held before. Mirrors MergeMovedRow. */
export interface MergeMovedRow {
  id: number;
  track_id: number;
}

/** One album membership row a merge removed or added. Mirrors MergeMembership. */
export interface MergeMembership {
  album_id: number;
  track_id: number;
  track_no: number | null;
  keep_own_cover: boolean;
}

/** An album whose membership a merge changed, with its updated_at before the merge. Mirrors MergeAlbumStamp. */
export interface MergeAlbumStamp {
  album_id: number;
  prev_updated_at: number;
}

/**
 * Everything one duplicate merge wrote. Held opaque by the frontend and sent back as-is, so the undo
 * replays exactly these rows. `dismissed` holds only the pairs the merge inserted. Mirrors MergeReceipt
 * in dto.rs.
 */
export interface MergeReceipt {
  keeper_id: number;
  moved_slots: MergeMovedRow[];
  moved_plays: MergeMovedRow[];
  removed_memberships: MergeMembership[];
  added_membership: MergeMembership | null;
  album_stamps: MergeAlbumStamp[];
  dismissed: DismissedPair[];
  inherited_visualizer: string | null;
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
  // The sections to include; absent, albums and singles export and playlists do not.
  include_albums?: boolean;
  include_singles?: boolean;
  include_playlists?: boolean;
  // 'file' for a portable .m3u8 per playlist, anything else for the flat mimic album.
  playlist_shape?: string;
  // Device mode: false drops a fresh dated snapshot folder, true merges into the picked device folder
  // in place (incremental update). Ignored for a folder export.
  device_in_place?: boolean;
  // Set only for a device export: the picked device target the staged library transfers onto. Absent,
  // the export writes straight into `destination`.
  device?: DeviceTarget;
  // A scoped export's explicit album/single id set: present narrows the plan to those containers,
  // absent exports every album/single (the general export).
  album_ids?: number[];
  // Writes only the files the destination's export record shows as new or changed. A dated device
  // snapshot refuses it.
  changed_only: boolean;
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
  // Tracks a changed-only run left alone because the destination already holds them; outside `total`.
  unchanged: number;
  cancelled: boolean;
  containers_written: number;
  items: ExportItem[];
}

/**
 * What a changed-only export would write to a destination, read against its export record. `files`
 * counts the files to write out of `total_files`; `albums`/`singles`/`playlists` count the containers
 * holding at least one. Mirrors ExportChangeSet in dto.rs.
 */
export interface ExportChangeSet {
  has_record: boolean;
  last_exported_at: number | null;
  albums: number;
  singles: number;
  playlists: number;
  files: number;
  total_files: number;
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

/**
 * One album entry in a playlist: a live reference to an album, not a copy of its tracks. `id` is the slot
 * identity shared with the track slots, so both kinds order and reorder together. `keep_order` plays the
 * album's tracks as one block. Mirrors PlaylistAlbumEntryRow in dto.rs.
 */
export interface PlaylistAlbumEntryRow {
  id: number;
  playlist_id: number;
  album_id: number;
  position: number;
  keep_order: boolean;
}

/** The load-all playlists payload: every playlist, track slot and album entry across them. Mirrors PlaylistSnapshot. */
export interface PlaylistSnapshot {
  playlists: PlaylistRow[];
  tracks: PlaylistTrackRow[];
  album_entries: PlaylistAlbumEntryRow[];
}

/** A run of queue rows that play together, as `[start, length]` over the queue's ids. */
export type QueueBlock = [number, number];

/** The engine's queue as the windows read it: ids in play order and the blocks over them. Mirrors QueueMirror. */
export interface QueueState {
  ids: number[];
  blocks: QueueBlock[];
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

/** The number of bands in the fine spectrum frame, the `player:spectrum_fine` payload. Mirrors FINE_BAND_COUNT in audio/source.rs. */
export const FINE_BAND_COUNT = 128;

/**
 * The loudness of the playing audio, the `player:level` payload: `rms` and `peak` in 0..1 through the
 * spectrum's dB window, and `flux`, the positive band change since the previous frame, in 0..1.
 * Mirrors LevelFrame in audio/mod.rs.
 */
export interface LevelFrame {
  rms: number;
  peak: number;
  flux: number;
}

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
  /** True while a plugin holds the output takeover: playback continues but Plisto's own output is muted. */
  output_taken_over: boolean;
  /** The seated plugin stream, or null. While set, `track_id` is the stream's ad-hoc id. */
  stream: StreamStatus | null;
  /** Bumps when an item starts cold or gaplessly or is loaded. Compared, never interpreted. */
  start_seq: number;
  /** Bumps on a user seek that took effect. Compared, never interpreted. */
  seek_seq: number;
}

/** The engine's phase for a seated stream. `playing` is the only phase that counts as `PlayerStatus.playing`. */
export type StreamPhase = "connecting" | "buffering" | "playing" | "paused";

/** The queue slot a stream's end re-seats: the track and the position it was parked at. */
export interface ParkedSlot {
  track_id: number;
  secs: number;
}

/**
 * The engine's view of a seated stream. `parked` names the track the queue returns to (null when
 * nothing is parked) and `parked_cleared` is true from a Clear queue until the parked queue gains a
 * track; the resume writer reads both. Mirrors StreamStatus in audio/mod.rs.
 */
export interface StreamStatus {
  live: boolean;
  seekable: boolean;
  phase: StreamPhase;
  parked: ParkedSlot | null;
  parked_cleared: boolean;
}

/** The hub's phases for a stream item, the display truth for the main button and the phase words. */
export type StreamNowState = "connecting" | "buffering" | "playing" | "paused" | "reconnecting";

/**
 * What a seated stream shows: the plugin's own title, artist, album and now line, the plugin identity
 * and the transport flags. The `player:stream` event and `get_stream_now` carry it; null when no stream
 * is seated. Mirrors StreamNow in plugins/api/stream/mod.rs.
 */
export interface StreamNow {
  item: number;
  plugin_id: string;
  plugin_name: string;
  title: string;
  artist: string | null;
  album: string | null;
  /** The live line (a station's current song); live items only. */
  now: string | null;
  live: boolean;
  seekable: boolean;
  state: StreamNowState;
  skip: { next: boolean; prev: boolean };
  /** Bumps when the artwork changes; 0 means none yet. */
  art_rev: number;
  /** Bumps on any change. */
  rev: number;
}

/** Why a stream ended. Mirrors StreamEndReason in plugins/api/stream/mod.rs. */
export type StreamEndReason =
  | "user"
  | "replaced"
  | "stopped"
  | "finished"
  | "plugin_gone"
  | "producer_gone"
  | "network"
  | "denied"
  | "unsupported"
  | "no_audio"
  | "stalled";

/** The `player:stream_end` payload, sent once per end for the player's toast. */
export interface StreamEndNotice {
  plugin_id: string;
  plugin_name: string;
  reason: StreamEndReason;
  detail: string | null;
}

/** An event for the plugin that owns the seated stream. Mirrors StreamEvent in plugins/api/stream/mod.rs. */
export type PluginStreamEvent =
  | { item: number; kind: "state"; state: StreamNowState }
  | { item: number; kind: "skip"; direction: "next" | "prev" }
  | { item: number; kind: "room"; room: number }
  | { item: number; kind: "ended"; reason: StreamEndReason; detail: string | null };

/** The `plugins:stream` payload: the owner's plugin id and the event for its frame. */
export interface PluginStreamPayload {
  id: string;
  event: PluginStreamEvent;
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
  | { kind: "tracks" }
  | { kind: "singles" }
  | { kind: "unsorted" }
  | { kind: "history" }
  | { kind: "single"; id: number; label: string };

/**
 * One track's play-log aggregate for the History surface: its most recent play (unix seconds), its
 * raw play count, and how many of those plays ran to the end. Mirrors HistoryRow in dto.rs. The
 * frontend hydrates the track row from its own store and reads the count and last-play stamp off this.
 */
export interface HistoryRow {
  track_id: number;
  last_played_at: number;
  play_count: number;
  completed_count: number;
}

/** The play-log stat the History grid's trailing column reads for one track: its last-play stamp
 *  (unix seconds) and raw play count. A light shape keyed by track id, built from HistoryRow. */
export interface HistoryStat {
  lastPlayedAt: number;
  playCount: number;
}

/**
 * One raw play-log event for the History timeline: the play's own id, its track, when it happened
 * (unix seconds), and whether it ran to the end. Not deduped - a track repeats once per listen, and
 * `play_id` keys each repeat apart. Mirrors PlayEvent in dto.rs.
 */
export interface PlayEvent {
  play_id: number;
  track_id: number;
  played_at: number;
  completed: boolean;
}

/** One album's stored visualizer default. Mirrors AlbumVisualizer in dto.rs. */
export interface AlbumVisualizer {
  album_id: number;
  kind: string;
}

/** One track's stored visualizer default. Mirrors TrackVisualizer in dto.rs. */
export interface TrackVisualizer {
  track_id: number;
  kind: string;
}

/** Every stored visualizer default. Mirrors VisualizerDefaults in dto.rs. */
export interface VisualizerDefaults {
  albums: AlbumVisualizer[];
  tracks: TrackVisualizer[];
}

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

/** Where a plugin stands. Mirrors EntryState in registry.rs. */
export type PluginEntryState = "needs_consent" | "ready" | "broken" | "incompatible";

/** A plugin's tier. Mirrors Tier in manifest.rs. */
export type PluginTier = "ui" | "native";

/** A plugin capability in its manifest spelling. Mirrors Capability in manifest.rs. */
export type PluginCapability =
  | "storage"
  | "library.read"
  | "playback.read"
  | "playback.control"
  | "network"
  | "background"
  | "ui.toast"
  | "ui.confirm"
  | "ui.chips"
  | "ui.sidebar"
  | "audio.tap"
  | "audio.events"
  | "audio.device"
  | "audio.output_takeover"
  | "playback.stream";

/** How a plugin's sidebar items are laid out. Mirrors Layout in sidebar_decl.rs. */
export type PluginSidebarLayout = "compact" | "section";

/** An app working mode a plugin can show in. Mirrors Mode in manifest.rs. */
export type PluginMode = "player" | "organizer";

/** What a declared sidebar item is. Mirrors ItemType in sidebar_decl.rs. */
export type PluginSidebarItemType = "nav" | "status" | "progress" | "toggle" | "action";

/** One declared sidebar item. `route` and `icon` are null unless a nav item set them. */
export interface PluginSidebarItem {
  id: string;
  type: PluginSidebarItemType;
  label: string;
  route: string | null;
  icon: string | null;
}

/** A manifest's sidebar block: its default layout and up to six items. */
export interface PluginSidebarDecl {
  layout: PluginSidebarLayout;
  items: PluginSidebarItem[];
}

/** Whether the running Plisto satisfies a manifest's `min_plisto`. Mirrors Compat in manifest.rs. */
export type PluginCompat = { state: "compatible" } | { state: "needs_newer"; min_plisto: string };

/**
 * The manifest fields a row shows, read from the installed `plugin.json`. Mirrors ManifestSummary in
 * plugins/summary.rs. `origins` are the declared network origins; `sidebar_items` counts the declared
 * sidebar entries.
 */
export interface PluginManifestSummary {
  name: string;
  author: string;
  homepage: string | null;
  capabilities: PluginCapability[];
  origins: string[];
  native_reason: string | null;
  sidebar_items: number;
  compat: PluginCompat;
  /** The app modes it shows in; never empty. A manifest without modes arrives as `["player"]`. */
  modes: PluginMode[];
  sidebar: PluginSidebarDecl | null;
  /** The page's entry file, relative to the plugin folder. For a native plugin, its program. */
  entry: string;
  /** A native plugin's own page, relative to the plugin folder; null when it has none or is a UI plugin. */
  page: string | null;
}

/** Every stable code a plugin API call fails with. Mirrors ApiCode in plugins/api/error.rs. */
export type PluginApiErrorCode =
  | "denied"
  | "rate_limited"
  | "invalid_args"
  | "too_large"
  | "not_found"
  | "unknown_method"
  | "busy"
  | "timeout"
  | "unavailable"
  | "network"
  | "aborted"
  | "plugin_error";

/** One refused plugin API call. `retry_after_ms` is present only with `rate_limited`. */
export interface PluginApiError {
  code: PluginApiErrorCode;
  message: string;
  retry_after_ms?: number;
  /** A finer cause under the code; "no_gesture" is the only one, always with `denied`. */
  reason?: string;
}

/** What `plugin_call` resolves: a result or an error, never both. Mirrors CallReply in api/error.rs. */
export interface PluginCallReply {
  ok: boolean;
  result?: unknown;
  error?: PluginApiError;
}

/** How a chip or status line is toned. Mirrors Tone in plugins/api/sidebar.rs. */
export type PluginTone = "neutral" | "accent" | "warn";

/** One chip beside a plugin's row: free text or a count. Mirrors Chip in plugins/api/sidebar.rs. */
export interface PluginChip {
  text: string | null;
  count: number | null;
  tone: PluginTone;
}

/**
 * The live state of one declared sidebar item, one shape per item type; every field is always set.
 * Mirrors ItemState in plugins/api/sidebar.rs.
 */
export type PluginItemState =
  | { type: "nav"; visible: boolean; label: string | null; chip: PluginChip | null }
  | { type: "status"; visible: boolean; tone: PluginTone; text: string }
  | { type: "progress"; visible: boolean; value: number | null; text: string | null }
  | { type: "toggle"; visible: boolean; on: boolean; enabled: boolean }
  | { type: "action"; visible: boolean; label: string | null; enabled: boolean };

/** One plugin's live sidebar state at boot. Mirrors SidebarSnapshot in plugins/api/sidebar.rs. */
export interface PluginSidebarSnapshot {
  id: string;
  chips: PluginChip[];
  items: { item_id: string; state: PluginItemState }[];
}

/** A sidebar change pushed on "plugins:sidebar". Mirrors SidebarEvent in plugins/api/host_event.rs. */
export type PluginSidebarEvent =
  | { id: string; kind: "chips"; chips: PluginChip[] }
  | { id: string; kind: "item"; item_id: string; state: PluginItemState };

/** A prompt or toast change pushed on "plugins:ui". Mirrors UiEvent in plugins/api/host_event.rs. */
export type PluginUiEvent =
  | { request_id: string; id: string; kind: "toast"; payload: { text: string; action: string | null } }
  | {
      request_id: string;
      id: string;
      kind: "confirm";
      payload: { title: string; body: string; confirm_label: string; cancel_label: string | null };
    }
  | { request_id: string; id: string; kind: "close"; payload: Record<string, never> }
  | { request_id: string; id: string; kind: "open_page"; payload: { route: string | null } };

/** What the user did with a toast or a prompt. Mirrors UiAnswer in plugins/api/ui_state.rs. */
export type PluginUiAnswer = { kind: "toast"; action: boolean } | { kind: "confirm"; value: boolean };

/** The gesture a click on a toggle or action earned, for the plugin's frame. Mirrors SidebarDelivery. */
export interface PluginSidebarDelivery {
  item_id: string;
  value: boolean | null;
  gesture: string;
}

/** What `plugin_sidebar_input` answers. Mirrors SidebarInputReply in plugins/api/sidebar.rs. */
export interface PluginSidebarInputReply {
  accepted: boolean;
  frame: PluginSidebarDelivery | null;
}

/** A page event a native plugin sent for its open page. Mirrors the `plugins:page_event` payload. */
export interface PluginPageEvent {
  id: string;
  topic: string;
  data: unknown;
}

/** An app event topic for one plugin, pushed on "plugins:event". Mirrors TopicEvent in plugins/api/host_event.rs. */
export interface PluginTopicEvent {
  id: string;
  topic: string;
  data: unknown;
  /** Strictly rises across the events produced for the plugin; gaps are normal. */
  seq: number;
}

/** What a library change reports to Rust: the changed ids (null when many or unknown) and the scopes touched. */
export interface LibraryChange {
  track_ids: number[] | null;
  albums: boolean;
  playlists: boolean;
}

/**
 * A streamed-response or socket event pushed on "plugins:net" for one plugin. Chunk `seq` counts from 1
 * with no gaps; binary payloads ride as base64. Mirrors HostEvent::Net in plugins/api/host_event.rs.
 */
export type PluginNetEvent =
  | { id: string; stream: string; kind: "chunk"; seq: number; data_b64: string }
  | { id: string; stream: string; kind: "end" }
  | { id: string; stream: string; kind: "error"; code: string; reason: string | null }
  | { id: string; socket: string; kind: "text"; data: string }
  | { id: string; socket: string; kind: "binary"; data_b64: string }
  | { id: string; socket: string; kind: "close"; code: number; reason: string; clean: boolean };

/** One request Plisto made for a plugin. Mirrors NetLogEntry in plugins/api/net/state.rs. */
export interface PluginNetLogEntry {
  at_ms: number;
  kind: "fetch" | "stream" | "socket" | "playback";
  method: string;
  origin: string;
  status: number | null;
  error: string | null;
  sent: number;
  received: number;
  ms: number;
}

/** What Windows reports about a proxy on the current network. Mirrors the reply of plugin_net_environment. */
export interface PluginNetEnvironment {
  proxy: "none" | "manual" | "pac" | "detected";
}

/** The loopback listeners opened for the sandbox self-check. Mirrors the reply of sandbox_check_open. */
export interface SandboxCheckSinks {
  token: string;
  udp_port: number;
  tcp_port: number;
}

/** What reached the listeners. Mirrors the reply of sandbox_check_close. */
export interface SandboxCheckCounts {
  udp: number;
  tcp: number;
}

/** What a plugin frame reports to Rust. Mirrors the kinds `plugin_frame_event` accepts. */
export type PluginFrameEventKind = "live" | "not_responding" | "crashed" | "detached";

/** Why a frame crashed, sent with the `crashed` kind. */
export type PluginFrameCrashReason = "silent" | "navigated" | "init";

/**
 * One registry entry with the problem found at boot, if any. Mirrors PluginRow in state.rs, whose entry
 * is flattened in. A broken row adopted from an invalid manifest carries placeholder tier and version.
 * `manifest` is null when the installed manifest cannot be read.
 */
export interface PluginRow {
  id: string;
  version: string;
  tier: PluginTier;
  enabled: boolean;
  granted: PluginCapability[];
  /** The network origins the user consented to, as enforced; empty without the network capability. */
  granted_origins: string[];
  installed_at: number;
  manifest_hash: string;
  state: PluginEntryState;
  source_path: string | null;
  sidebar_collapsed: boolean;
  /** Set only while a formerly ready plugin sits broken or incompatible: whether it was enabled. */
  ready_enabled?: boolean;
  problem: string | null;
  manifest: PluginManifestSummary | null;
}

/** Whether plugins may run: held for the user's answer, running, or off for the session. */
export type PluginRuntime = "held" | "running" | "safe";

/** The boot view. Mirrors BootView in state.rs: the runtime gate and what the previous run left. */
export interface PluginBootState {
  runtime: PluginRuntime;
  unclean: boolean;
  safe_flag: boolean;
}

/** Where a plugin's host side stands. Mirrors HostState in native/status.rs. */
export type PluginHostState =
  | { host: "off" }
  | { host: "starting" }
  | { host: "running" }
  | { host: "not_responding" }
  | { host: "stopping" }
  | { host: "restarting"; retry_in_ms: number }
  | { host: "stopped" }
  | { host: "crash_loop" }
  | { host: "failed"; reason: "invalid" | "changed" | "launch_denied" };

/** Why Rust took a plugin's output takeover away. */
export type PluginTakeoverReason =
  | "granted"
  | "released"
  | "denied"
  | "busy"
  | "user"
  | "not_responding"
  | "stopped";

/** One plugin's supervised status. Mirrors PluginStatus in native/status.rs. */
export type PluginStatus = PluginHostState & {
  id: string;
  /** What a native plugin last reported; null until its first valid status and for UI plugins. */
  reported: { state: "on" | "idle" | "warn"; text: string | null } | null;
  /** This plugin holds Plisto's output now. */
  takeover: boolean;
  takeover_revoked: PluginTakeoverReason | null;
  crash: { reason: string; exit_code: number | null; at_ms: number } | null;
  protocol_errors: number;
  /** Per plugin, grows with every change; an event that is not newer is stale. */
  rev: number;
};

/** Plisto's own notice about a plugin, from `plugins:notice`. */
export type PluginNotice =
  | { id: string; kind: "auto_disabled" }
  /** Raised by the frontend after the user took the output back; `id` is null when the holder is unknown. */
  | { id: string | null; kind: "takeover_returned" };

/** What the review sheet shows before an install or update. Mirrors Inspection in install.rs. */
export interface PluginInspection {
  token: string;
  id: string;
  name: string;
  version: string;
  author: string;
  tier: PluginTier;
  capabilities: PluginCapability[];
  native_reason: string | null;
  homepage: string | null;
  compat: PluginCompat;
  file_count: number;
  total_bytes: number;
  /** The installed version when the id is already installed; empty when only its folder exists. */
  installed: string | null;
  origins: string[];
  sidebar_items: number;
  /** True when the id is not installed but a saved-data folder already exists for it. */
  leftover_data: boolean;
}

/** What waits in the plugins inbox folder. Mirrors InboxItem in install.rs. */
export interface PluginInboxItem {
  name: string;
  path: string;
  kind: "folder" | "file";
}

/** The result of an update. Mirrors Updated in update.rs. */
export interface PluginUpdated {
  row: PluginRow;
  previous_version: string;
  /** The author of the replaced version; empty when its manifest no longer validates. */
  previous_author: string;
}

/** The end of a plugin's logs. Mirrors LogTail in log_tail.rs; `stderr` is null for a UI plugin. */
export interface PluginLogTail {
  plugin: string[];
  stderr: string[] | null;
}

/** The result of an uninstall. Mirrors Uninstalled in lifecycle.rs. */
export interface PluginUninstalled {
  id: string;
  /** Set when the saved data was to be deleted and could not be. */
  data_warning: string | null;
}

/** Every stable `code` an install or lifecycle command rejects with. Mirrors ErrorCode in install_error.rs. */
export type PluginInstallErrorCode =
  | "not_found"
  | "too_large"
  | "too_many_files"
  | "unsafe_path"
  | "link_not_allowed"
  | "stream_not_allowed"
  | "name_collision"
  | "bad_archive"
  | "invalid_manifest"
  | "bad_icon"
  | "missing_file"
  | "already_installed"
  | "unknown_token"
  | "registry_unavailable"
  | "io"
  | "not_installed"
  | "tier_changed"
  | "incompatible"
  | "broken"
  | "manifest_changed"
  | "consent_mismatch"
  | "native_ack_required"
  | "needs_reinstall"
  | "busy";

/** The rejection of an install or lifecycle command. `detail` is for logs, never for the user. */
export interface PluginInstallError {
  code: PluginInstallErrorCode;
  detail: string;
}
