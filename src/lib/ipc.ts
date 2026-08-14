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
  DestinationCheck,
  ExportProgress,
  ExportSummary,
  GenreRemovalImpact,
  GenreRow,
  ListTracksResponse,
  OrganizationSnapshot,
  Root,
  RootRemovalImpact,
  ScanProgress,
  ScanSummary,
  SortSpec,
  TrackEdit,
  TrackEditFields,
  TrackOverride,
  TrackPlacement,
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

/** Every library root with its live track count. */
export function listRoots(): Promise<Root[]> {
  return invoke<Root[]>("list_roots");
}

/** Adds `path` as a new root and scans just it, streaming progress, resolving with the summary. */
export function addRoot(path: string, channel: Channel<ScanProgress>): Promise<ScanSummary> {
  return invoke<ScanSummary>("add_root", { path, onProgress: channel });
}

/** Removes a root: its tracks and their memberships are dropped and emptied albums deleted. */
export function removeRoot(id: number): Promise<void> {
  return invoke("remove_root", { id });
}

/** Rescans one root incrementally, streaming progress, resolving with the summary. */
export function rescanRoot(id: number, channel: Channel<ScanProgress>): Promise<ScanSummary> {
  return invoke<ScanSummary>("rescan_root", { id, onProgress: channel });
}

/** Rescans every root (the global refresh), streaming progress, resolving with the summary. */
export function rescanAll(channel: Channel<ScanProgress>): Promise<ScanSummary> {
  return invoke<ScanSummary>("rescan_all", { onProgress: channel });
}

/** The blast radius of removing a root: tracks dropped, albums shrunk, albums deleted. */
export function rootRemovalImpact(id: number): Promise<RootRemovalImpact> {
  return invoke<RootRemovalImpact>("root_removal_impact", { id });
}

/** Wraps a progress callback in a fresh channel the export streams ticks over. */
export function createExportChannel(
  onProgress: (progress: ExportProgress) => void,
): Channel<ExportProgress> {
  const channel = new Channel<ExportProgress>();
  channel.onmessage = onProgress;
  return channel;
}

/**
 * Exports the organized library to `destination`, streaming progress, resolving with the report.
 * The album layout follows `folderPattern`/`filePattern` (token language); left empty, the backend
 * falls back to the shipped default layout. Singles ignore the template.
 */
export function exportLibrary(
  destination: string,
  channel: Channel<ExportProgress>,
  folderPattern = "",
  filePattern = "",
): Promise<ExportSummary> {
  return invoke<ExportSummary>("export_library", {
    config: { destination, folder_pattern: folderPattern, file_pattern: filePattern },
    onProgress: channel,
  });
}

/** Renders a sample export path for the album templates, using the backend's real derivation. */
export function exportTemplatePreview(
  folderPattern: string,
  filePattern: string,
): Promise<string> {
  return invoke<string>("export_template_preview", { folderPattern, filePattern });
}

/** Signals the running export to stop. The backend finishes its current file and reports cancelled. */
export function cancelExport(): Promise<void> {
  return invoke("cancel_export");
}

/** Inspects a picked destination before a run: workspace overlap, non-empty warn, writability. */
export function validateExportDestination(destination: string): Promise<DestinationCheck> {
  return invoke<DestinationCheck>("validate_export_destination", { destination });
}

/** Resolves a track's single cover at `size`, or null when it has no art from any source. */
export function readCover(trackId: number, size: CoverSize): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("read_cover", { trackId, size });
}

/** Resolves an album's cover at `size`: its bound cover, else a member track's art, else null. */
export function albumCover(albumId: number, size: CoverSize): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("album_cover", { albumId, size });
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

/** Writes the track's resolved cover to `destPath` at full resolution, verbatim. */
export function saveTrackCover(trackId: number, destPath: string): Promise<void> {
  return invoke("save_track_cover", { trackId, destPath });
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

/** Promotes one loose track into a single: an album-of-one seeded from the track's raw tags. */
export function createSingle(trackId: number): Promise<AlbumRow> {
  return invoke<AlbumRow>("create_single", { trackId });
}

/** Deletes an album (or single). Its membership cascades away; the track rows fall back to loose. */
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

/** Rewrites an album's disc grouping and per-disc numbering atomically (disc + track_no together). */
export function setAlbumLayout(albumId: number, placements: TrackPlacement[]): Promise<void> {
  return invoke("set_album_layout", { albumId, placements });
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

/**
 * Replaces one track's whole edit-layer metadata with the given full set (a null clears one). The
 * Files-view full editor's write; works for a loose track too.
 */
export function setTrackEdit(trackId: number, fields: TrackEditFields): Promise<void> {
  return invoke("set_track_edit", { trackId, fields });
}

/** Reads one track's raw edit-layer overrides and its genres, to hydrate the Files-view editor. */
export function getTrackEdit(trackId: number): Promise<TrackEdit> {
  return invoke<TrackEdit>("get_track_edit", { trackId });
}

/** Binds a picked image as an album's cover, returning the newly resolved cover. */
export function setAlbumCover(albumId: number, srcPath: string): Promise<CoverRef> {
  return invoke<CoverRef>("set_album_cover", { albumId, srcPath });
}

/** Loads the whole organize state in one pass: every album with its count, and every membership row. */
export function loadOrganization(): Promise<OrganizationSnapshot> {
  return invoke<OrganizationSnapshot>("load_organization");
}

/** The whole genre vocabulary, each entry with its usage count. */
export function listGenres(): Promise<GenreRow[]> {
  return invoke<GenreRow[]>("list_genres");
}

/** Creates a genre, or returns the existing row when its folded spelling already exists. */
export function createGenre(name: string): Promise<GenreRow> {
  return invoke<GenreRow>("create_genre", { name });
}

/** Renames a genre; a rename that collides with another genre's folded key is rejected. */
export function renameGenre(id: number, name: string): Promise<void> {
  return invoke("rename_genre", { id, name });
}

/** Deletes a genre; it cascades off every track that carried it. */
export function deleteGenre(id: number): Promise<void> {
  return invoke("delete_genre", { id });
}

/** How many distinct tracks carry a genre, for the counted confirm before deleting it. */
export function genreRemovalImpact(id: number): Promise<GenreRemovalImpact> {
  return invoke<GenreRemovalImpact>("genre_removal_impact", { id });
}

/** Folds one genre into another: source-carrying tracks keep the target, then the source is deleted. */
export function mergeGenres(sourceId: number, targetId: number): Promise<void> {
  return invoke("merge_genres", { sourceId, targetId });
}

/** Replaces one track's whole genre list with `genreIds`, in order. Works for a loose track too. */
export function setTrackGenres(trackId: number, genreIds: number[]): Promise<void> {
  return invoke("set_track_genres", { trackId, genreIds });
}

/** Bulk-adds a genre to every member of an album, skipping members that already carry it. */
export function addAlbumGenre(albumId: number, genreId: number): Promise<void> {
  return invoke("add_album_genre", { albumId, genreId });
}

/** Bulk-removes a genre from every member of an album. */
export function removeAlbumGenre(albumId: number, genreId: number): Promise<void> {
  return invoke("remove_album_genre", { albumId, genreId });
}

/** Reads the persisted workspace root (real-case, as first picked), or null when none is set. */
export function workspaceRoot(): Promise<string | null> {
  return invoke<string | null>("workspace_root");
}

/** Reads one setting from the kv table, or null when the key was never written. */
export function getSetting(key: string): Promise<string | null> {
  return invoke<string | null>("get_setting", { key });
}

/** Writes one setting into the kv table, inserting or replacing the key. */
export function setSetting(key: string, value: string): Promise<void> {
  return invoke("set_setting", { key, value });
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
