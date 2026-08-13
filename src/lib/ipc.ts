/*
 * Typed wrappers over the Tauri command surface. One function per backend command, so no
 * component or store passes a raw string name or hand-builds an args object. Rust snake_case
 * parameters map to camelCase keys here (Tauri's convention).
 */

// -- Library Imports --
import { invoke, Channel } from "@tauri-apps/api/core";

// -- Type Imports --
import type {
  CoverCandidate,
  CoverRef,
  CoverSize,
  ListTracksResponse,
  ScanProgress,
  ScanSummary,
  SortSpec,
} from "../types";

/** Wraps a progress callback in a fresh channel the scan streams ticks over. */
export function createScanChannel(
  onProgress: (progress: ScanProgress) => void,
): Channel<ScanProgress> {
  const channel = new Channel<ScanProgress>();
  channel.onmessage = onProgress;
  return channel;
}

/** Scans `path` into the index, streaming progress over `channel`, resolving with the summary. */
export function scanWorkspace(
  path: string,
  channel: Channel<ScanProgress>,
): Promise<ScanSummary> {
  return invoke<ScanSummary>("scan_workspace", { path, onProgress: channel });
}

/** Signals the running scan to stop. The backend commits its partial index and reports cancelled. */
export function cancelScan(): Promise<void> {
  return invoke("cancel_scan");
}

/** Resolves a track's single cover at `size`, or null when it has no art from any source. */
export function readCover(trackId: number, size: CoverSize): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("read_cover", { trackId, size });
}

/** Lists every selectable art source for a track: its embedded picture, then adjacent images. */
export function listCoverCandidates(trackId: number): Promise<CoverCandidate[]> {
  return invoke<CoverCandidate[]>("list_cover_candidates", { trackId });
}

/** Binds a picked image as the folder cover for the track, returning the newly resolved cover. */
export function importFolderCover(trackId: number, srcPath: string): Promise<CoverRef> {
  return invoke<CoverRef>("import_folder_cover", { trackId, srcPath });
}

/** Drops the folder cover and returns whatever art the folder falls back to, or null. */
export function removeFolderCover(trackId: number): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("remove_folder_cover", { trackId });
}

/** Reads a window of indexed tracks plus the full filtered count. Omitted args load every row. */
export function listTracks(args: {
  filter?: string;
  sort?: SortSpec;
  offset?: number;
  limit?: number;
} = {}): Promise<ListTracksResponse> {
  return invoke<ListTracksResponse>("list_tracks", {
    filter: args.filter,
    sort: args.sort,
    offset: args.offset,
    limit: args.limit,
  });
}
