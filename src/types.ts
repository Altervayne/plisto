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

/** The load-all organize payload. Mirrors OrganizationSnapshot in dto.rs. */
export interface OrganizationSnapshot {
  albums: AlbumRow[];
  membership: AlbumTrackRow[];
}

/** The one choice export asks: the destination. Mirrors ExportConfig in dto.rs. */
export interface ExportConfig {
  destination: string;
}

/** The stage a running export is in. Mirrors ExportPhase in dto.rs. */
export type ExportPhase = 'preparing' | 'copying' | 'done';

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

/** The up-front verdict on a picked destination. Mirrors DestinationCheck in dto.rs. */
export interface DestinationCheck {
  ok: boolean;
  inside_workspace: boolean;
  non_empty: boolean;
  writable: boolean;
}
