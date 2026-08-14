/*
 * Typed wrappers over the Tauri command surface. One function per backend command, so no
 * component or store passes a raw string name or hand-builds an args object. Rust snake_case
 * parameters map to camelCase keys here (Tauri's convention).
 */

// -- Library Imports --
import { invoke, Channel } from "@tauri-apps/api/core";

// -- Type Imports --
import type {
  AlbumFields,
  AlbumRow,
  CoverCandidate,
  CoverRef,
  CoverSize,
  ListTracksResponse,
  OrganizationSnapshot,
  ScanProgress,
  ScanSummary,
  SortSpec,
  TrackOverride,
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

/** Creates an album from `trackIds`, seeding fields from the caller and the cover from the backend. */
export function createAlbum(fields: AlbumFields, trackIds: number[]): Promise<AlbumRow> {
  return invoke<AlbumRow>("create_album", {
    title: fields.title,
    albumArtist: fields.album_artist,
    year: fields.year,
    genre: fields.genre,
    trackIds,
  });
}

/** Deletes an album. Its membership cascades away; the track rows stay and fall back to loose. */
export function deleteAlbum(albumId: number): Promise<void> {
  return invoke("delete_album", { albumId });
}

/** Assigns tracks to an album: a track elsewhere moves here, a loose one is appended, a member stays. */
export function addTracksToAlbum(albumId: number, trackIds: number[]): Promise<void> {
  return invoke("add_tracks_to_album", { albumId, trackIds });
}

/** Removes tracks from an album. They become loose again; their track rows are untouched. */
export function removeTracksFromAlbum(albumId: number, trackIds: number[]): Promise<void> {
  return invoke("remove_tracks_from_album", { albumId, trackIds });
}

/** Rewrites an album's whole track order to `orderedTrackIds` (track_no 1..N). */
export function setTrackOrder(albumId: number, orderedTrackIds: number[]): Promise<void> {
  return invoke("set_track_order", { albumId, orderedTrackIds });
}

/** Replaces an album's title, artist, year and genre with the given full set (a null clears one). */
export function setAlbumFields(albumId: number, fields: AlbumFields): Promise<void> {
  return invoke("set_album_fields", { albumId, fields });
}

/** Replaces one membership row's overrides and numbering with the given full set (a null clears one). */
export function setTrackOverrides(
  albumId: number,
  trackId: number,
  over: TrackOverride,
): Promise<void> {
  return invoke("set_track_overrides", { albumId, trackId, over });
}

/** Binds a picked image as an album's cover, returning the newly resolved cover. */
export function setAlbumCover(albumId: number, srcPath: string): Promise<CoverRef> {
  return invoke<CoverRef>("set_album_cover", { albumId, srcPath });
}

/** Loads the whole organize state in one pass: every album with its count, and every membership row. */
export function loadOrganization(): Promise<OrganizationSnapshot> {
  return invoke<OrganizationSnapshot>("load_organization");
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
