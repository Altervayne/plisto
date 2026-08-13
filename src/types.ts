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
  errors: number;
  cancelled: boolean;
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
