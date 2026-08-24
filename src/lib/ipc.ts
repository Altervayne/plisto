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
  AppliedResult,
  BulkEditResult,
  BulkSetFields,
  CoverCandidate,
  CoverRef,
  CoverSize,
  DestinationCheck,
  DeviceTarget,
  ExportProgress,
  ExportStatus,
  ExportSummary,
  ExportTarget,
  ExtractResult,
  ExtractRow,
  GenreRemovalImpact,
  GenreRow,
  ImageFolderGroup,
  ListTracksResponse,
  OrganizationSnapshot,
  PlaylistM3uSummary,
  PlaylistRow,
  PlaylistSnapshot,
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
 * Exports the organized library to `target`, streaming progress, resolving with the report. A folder
 * target writes straight into its path; a device target stages the library to a temp folder and
 * transfers it onto the device, so `destination` goes empty and `device` carries the picked target.
 * The album layout follows `folderPattern`/`filePattern` (token language); left empty, the backend
 * falls back to the shipped default layout. Singles ignore the template.
 */
export function exportLibrary(
  target: ExportTarget,
  channel: Channel<ExportProgress>,
  folderPattern = "",
  filePattern = "",
  sections: {
    albums?: boolean;
    singles?: boolean;
    playlists?: boolean;
    playlistShape?: "mimic" | "file";
    albumIds?: number[];
    deviceInPlace?: boolean;
  } = {},
): Promise<ExportSummary> {
  return invoke<ExportSummary>("export_library", {
    config: {
      destination: target.kind === "folder" ? target.path : "",
      device: target.kind === "device" ? target.target : undefined,
      // Device mode: merge into the picked folder in place, or drop a dated snapshot. Only a device
      // target reads it.
      device_in_place: target.kind === "device" ? sections.deviceInPlace ?? false : false,
      folder_pattern: folderPattern,
      file_pattern: filePattern,
      // Sections default to the pre-1.5 shape: albums + singles on, playlists opt-in.
      include_albums: sections.albums ?? true,
      include_singles: sections.singles ?? true,
      include_playlists: sections.playlists ?? false,
      playlist_shape: sections.playlistShape ?? "mimic",
      // Scoping is opt-in: an explicit id set narrows the plan to those albums/singles. Omitted, the
      // key drops out and the export stays general.
      album_ids: sections.albumIds,
    },
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

/** Opens the device-capable folder picker; resolves with the picked device target or null on cancel. */
export function pickDeviceFolder(): Promise<DeviceTarget | null> {
  return invoke<DeviceTarget | null>("pick_device_folder");
}

/** Validates a picked device target: re-resolves its PIDL to confirm the device is still connected. */
export function checkDevice(pidl: string): Promise<DestinationCheck> {
  return invoke<DestinationCheck>("check_device", { pidl });
}

/** The app-global export snapshot, for the tray popup opening mid-run: running flag and latest tick. */
export function getExportStatus(): Promise<ExportStatus> {
  return invoke<ExportStatus>("get_export_status");
}

/** Brings the main window back from the tray: shows, unminimizes and focuses it. */
export function showMainWindow(): Promise<void> {
  return invoke("show_main_window");
}

/** Quits the app from the tray popup. */
export function quitApp(): Promise<void> {
  return invoke("quit_app");
}

/**
 * Resolves a track's single cover at `size`, or null when it has no art from any source. `keepOwn`
 * mirrors the membership's keep-own-cover flag: when set, the folder cover steps aside so the track
 * shows its own embedded/adjacent art (falling back to the folder cover only when it has none).
 */
export function readCover(
  trackId: number,
  size: CoverSize,
  keepOwn = false,
): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("read_cover", { trackId, size, keepOwn });
}

/** Resolves an album's cover at `size`: its bound cover, else a member track's art, else null. */
export function albumCover(albumId: number, size: CoverSize): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("album_cover", { albumId, size });
}

/** Lists every selectable art source for a track: its embedded picture, then adjacent images. */
export function listCoverCandidates(trackId: number): Promise<CoverCandidate[]> {
  return invoke<CoverCandidate[]>("list_cover_candidates", { trackId });
}

/** Every loose image sitting directly in the track's own folder, each a full on-disk path, sorted. */
export function listFolderImages(trackId: number): Promise<string[]> {
  return invoke<string[]>("list_folder_images", { trackId });
}

/** Binds a picked image as the folder cover for the track, returning the newly resolved cover. */
export function importFolderCover(trackId: number, srcPath: string): Promise<CoverRef> {
  return invoke<CoverRef>("import_folder_cover", { trackId, srcPath });
}

/** Drops the folder cover and returns whatever art the folder falls back to, or null. */
export function removeFolderCover(trackId: number): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("remove_folder_cover", { trackId });
}

/** Assigns a picked image as the cover for each track, returning the newly resolved cover. */
export function importTrackCover(trackIds: number[], srcPath: string): Promise<CoverRef> {
  return invoke<CoverRef>("import_track_cover", { trackIds, srcPath });
}

/** Clears the assigned cover from each track; each falls back to its folder/keep-own resolution. */
export function removeTrackCover(trackIds: number[]): Promise<void> {
  return invoke("remove_track_cover", { trackIds });
}

/** Writes the track's resolved cover to `destPath` at full resolution, verbatim. */
export function saveTrackCover(trackId: number, destPath: string): Promise<void> {
  return invoke("save_track_cover", { trackId, destPath });
}

/** The dotless extension of a track's cover, sniffed from its bytes, or null when it has none. */
export function trackCoverExt(trackId: number): Promise<string | null> {
  return invoke<string | null>("track_cover_ext", { trackId });
}

/** Wraps a batch callback in a fresh channel the discovery sweep streams folder groups over. */
export function createDiscoveryChannel(
  onBatch: (group: ImageFolderGroup) => void,
): Channel<ImageFolderGroup> {
  const channel = new Channel<ImageFolderGroup>();
  channel.onmessage = onBatch;
  return channel;
}

/** Streams every folder of loose images across the library over `channel`, with its needs-cover state. */
export function discoverLibraryImages(channel: Channel<ImageFolderGroup>): Promise<void> {
  return invoke("discover_library_images", { onBatch: channel });
}

/** Signals the running discovery sweep to stop. Groups already sent stand; nothing is written. */
export function cancelDiscovery(): Promise<void> {
  return invoke("cancel_discovery");
}

/** Generates a thumbnail for an arbitrary on-disk image at `size`, or null when it cannot be read. */
export function imageThumb(srcPath: string, size: CoverSize): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("image_thumb", { srcPath, size });
}

/** Binds a picked image as the cover for a folder addressed by its path, returning the resolved cover. */
export function importFolderCoverByPath(folderPath: string, srcPath: string): Promise<CoverRef> {
  return invoke<CoverRef>("import_folder_cover_by_path", { folderPath, srcPath });
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

/** Clears an album's bound cover; it falls back to a member track's art. */
export function removeAlbumCover(albumId: number): Promise<void> {
  return invoke("remove_album_cover", { albumId });
}

/** Flags the given album memberships to keep each track's own art on export, or clears the flag. */
export function setTrackKeepOwnCover(
  albumId: number,
  trackIds: number[],
  value: boolean,
): Promise<void> {
  return invoke("set_track_keep_own_cover", { albumId, trackIds, value });
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

/**
 * Force-applies an album's chosen fallback fields onto every member track, overwriting each member's
 * own edit for those fields. `albumArtist` and `year` overlay the album's value; `genre` unifies the
 * members to the union of their genres. Album name is deliberately excluded. Resolves with the count.
 */
export function applyAlbumFieldsToMembers(
  albumId: number,
  fields: { albumArtist: boolean; year: boolean; genre: boolean },
): Promise<AppliedResult> {
  return invoke<AppliedResult>("apply_album_fields_to_members", {
    albumId,
    albumArtist: fields.albumArtist,
    year: fields.year,
    genre: fields.genre,
  });
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

/**
 * Previews what each track's filename parses to under `pattern`, read-only and order-preserving. A
 * filename that does not fit the pattern, or a track that is not indexed, comes back matched:false
 * with empty fields.
 */
export function extractPreview(pattern: string, trackIds: number[]): Promise<ExtractRow[]> {
  return invoke<ExtractRow[]>("extract_preview", { pattern, trackIds });
}

/**
 * Writes the parsed values back onto the tracks, but only the fields named in `applyFields` (snake_case
 * keys) and only where they parsed - an unextracted field is never cleared. Genre appends to the track's
 * list; track_no lands on album members only, and loose tracks are skipped and counted in the result.
 */
export function extractApply(
  pattern: string,
  trackIds: number[],
  applyFields: string[],
): Promise<ExtractResult> {
  return invoke<ExtractResult>("extract_apply", { pattern, trackIds, applyFields });
}

/**
 * Sets one shared value across every track in `trackIds` and adds or removes genres over them. A
 * `set` field left out is untouched, an empty string clears it, a value sets it. Add names get-or-
 * create their genre; remove names match an existing genre or are skipped. Resolves with the count.
 */
export function bulkEditTracks(
  trackIds: number[],
  set: BulkSetFields,
  addGenres: string[],
  removeGenres: string[],
): Promise<BulkEditResult> {
  return invoke<BulkEditResult>("bulk_edit_tracks", { trackIds, set, addGenres, removeGenres });
}

/**
 * Writes a cleaned title onto each track, carrying every other edit field through unchanged. The dto
 * fields serialize snake_case, so each pair passes `track_id` verbatim under the camelCase arg.
 * Resolves with how many titles were written.
 */
export function applyTrackTitles(
  titles: { trackId: number; title: string }[],
): Promise<AppliedResult> {
  return invoke<AppliedResult>("apply_track_titles", {
    titles: titles.map(({ trackId, title }) => ({ track_id: trackId, title })),
  });
}

/** Loads every playlist with its slot count and every slot across all playlists, in one pass. */
export function loadPlaylists(): Promise<PlaylistSnapshot> {
  return invoke<PlaylistSnapshot>("load_playlists");
}

/** Creates an empty playlist, seeded with `name` (a null name reads as the untitled default). */
export function createPlaylist(name: string | null): Promise<PlaylistRow> {
  return invoke<PlaylistRow>("create_playlist", { name });
}

/** Renames a playlist; a null name clears it back to the untitled default. */
export function renamePlaylist(id: number, name: string | null): Promise<void> {
  return invoke("rename_playlist", { id, name });
}

/** Deletes a playlist and its slots. The track rows are untouched. */
export function deletePlaylist(id: number): Promise<void> {
  return invoke("delete_playlist", { id });
}

/** Appends tracks to a playlist as new slots. Duplicates are intended - a track may repeat. */
export function addTracksToPlaylist(playlistId: number, trackIds: number[]): Promise<void> {
  return invoke("add_tracks_to_playlist", { playlistId, trackIds });
}

/** Removes slots by their slot id, not their track id, so a repeated track drops one copy at a time. */
export function removePlaylistSlots(slotIds: number[]): Promise<void> {
  return invoke("remove_playlist_slots", { slotIds });
}

/** Rewrites a playlist's whole slot order to `orderedSlotIds` (positions 1..N). */
export function setPlaylistOrder(playlistId: number, orderedSlotIds: number[]): Promise<void> {
  return invoke("set_playlist_order", { playlistId, orderedSlotIds });
}

/** Sets a playlist's description; a null clears it back to unset. */
export function setPlaylistDescription(id: number, description: string | null): Promise<void> {
  return invoke("set_playlist_description", { id, description });
}

/** Binds a picked image as a playlist's cover, returning the newly resolved cover. */
export function setPlaylistCover(id: number, srcPath: string): Promise<CoverRef> {
  return invoke<CoverRef>("set_playlist_cover", { id, srcPath });
}

/** Drops a playlist's bound cover. Unlike an album, a playlist has no art to fall back to. */
export function removePlaylistCover(id: number): Promise<void> {
  return invoke("remove_playlist_cover", { id });
}

/** Resolves a playlist's bound cover at `size`, or null when none is set - no track fallback. */
export function playlistCover(playlistId: number, size: CoverSize): Promise<CoverRef | null> {
  return invoke<CoverRef | null>("playlist_cover", { playlistId, size });
}

/**
 * Writes a plain .m3u for the playlist at the chosen file `path`, its entries pointing at the original
 * source files. No copies, no cover - instant, resolving with the written/skipped counts.
 */
export function exportPlaylistM3u(playlistId: number, path: string): Promise<PlaylistM3uSummary> {
  return invoke<PlaylistM3uSummary>("export_playlist_m3u", { playlistId, path });
}

/**
 * Copies the playlist's tracks into `destination`, album-structured (loose tracks under Unsorted), with
 * the cover image, streaming progress over `channel` and resolving with the report. Each member album
 * lays out by `folderPattern`/`filePattern` (token language); left empty, the backend falls back to the
 * shipped default. Cancellable through `cancelPlaylistExport`. Mirrors the library export's channel wiring.
 */
export function exportPlaylistFolder(
  playlistId: number,
  target: ExportTarget,
  channel: Channel<ExportProgress>,
  folderPattern = "",
  filePattern = "",
  deviceInPlace = false,
): Promise<ExportSummary> {
  return invoke<ExportSummary>("export_playlist_folder", {
    playlistId,
    destination: target.kind === "folder" ? target.path : "",
    device: target.kind === "device" ? target.target : undefined,
    deviceInPlace: target.kind === "device" ? deviceInPlace : false,
    folderPattern,
    filePattern,
    onProgress: channel,
  });
}

/**
 * Copies the playlist's tracks into `destination` as a standalone Mimic Album: the folder itself is one
 * album, every track retagged to the playlist name and numbered in playlist order, with the embedded
 * cover and a cover.jpg - no bundled .m3u. Streams progress over `channel` and resolves with the report.
 * Cancellable through `cancelPlaylistExport`.
 */
export function exportPlaylistMimicAlbum(
  playlistId: number,
  destination: string,
  channel: Channel<ExportProgress>,
): Promise<ExportSummary> {
  return invoke<ExportSummary>("export_playlist_mimic_album", {
    playlistId,
    destination,
    onProgress: channel,
  });
}

/**
 * Writes a re-openable folder into `destination`: the .m3u8, its cover.jpg, and a .nomedia. No track
 * copies - instant, resolving with the written/skipped counts.
 */
export function exportPlaylistRichM3u8(
  playlistId: number,
  destination: string,
): Promise<PlaylistM3uSummary> {
  return invoke<PlaylistM3uSummary>("export_playlist_rich_m3u8", { playlistId, destination });
}

/** Signals the running folder export to stop. The backend finishes its current file and reports cancelled. */
export function cancelPlaylistExport(): Promise<void> {
  return invoke("cancel_playlist_export");
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
