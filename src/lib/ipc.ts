/*
 * Typed wrappers over the Tauri command surface. One function per backend command, so no
 * component or store passes a raw string name or hand-builds an args object. Rust snake_case
 * parameters map to camelCase keys here (Tauri's convention).
 */

// -- Library Imports --
import { invoke, Channel } from "@tauri-apps/api/core";

// -- Type Imports --
import type {
  AlbumCoverEntry,
  AlbumFields,
  AlbumRow,
  AnalyzeProgress,
  AppliedResult,
  BulkEditResult,
  BulkSetFields,
  CoverCandidate,
  CoverRef,
  CoverSize,
  CueSheet,
  DestinationCheck,
  DeviceTarget,
  DismissedPair,
  ExportChangeSet,
  ExportConfig,
  ExportProgress,
  ExportStatus,
  ExportSummary,
  ExportTarget,
  ExtractResult,
  ExtractRow,
  GenreRemovalImpact,
  GenreRow,
  HistoryRow,
  ImageFolderGroup,
  KeptBackup,
  KeptDiscardAllOutcome,
  KeptDiscardOutcome,
  LastFileWrite,
  LibrarySyncStatus,
  ListTracksResponse,
  LocateFolderOutcome,
  LocateFolderPreview,
  LoudnessCoverage,
  MergeReceipt,
  OrganizationSnapshot,
  OutputDeviceInfo,
  PlayEvent,
  PlayerNotice,
  PlayerStatus,
  PluginBootState,
  PluginCallReply,
  PluginFrameCrashReason,
  LibraryChange,
  PluginFrameEventKind,
  PluginInboxItem,
  PluginInspection,
  PluginNetEnvironment,
  PluginLogTail,
  PluginNetLogEntry,
  PluginRow,
  PluginSidebarInputReply,
  PluginSidebarSnapshot,
  PluginStatus,
  PluginUiAnswer,
  PluginUiEvent,
  PluginUninstalled,
  PluginUpdated,
  PluginVisKindState,
  PluginVisMark,
  PluginVisTheme,
  PlaylistM3uSummary,
  PlaylistRow,
  PlaylistSnapshot,
  PurgeSummary,
  QueueBlock,
  QueueState,
  RelinkCandidate,
  RelocateOutcome,
  RelocatePreview,
  RepeatMode,
  RestoreOutcome,
  RestorePointList,
  RestorePreview,
  Root,
  RootRemovalImpact,
  SandboxCheckCounts,
  SandboxCheckSinks,
  ScanIssuePage,
  ScanIssueReason,
  ScanIssueRetryResult,
  ScanProgress,
  ScanSummary,
  SilenceSpan,
  SortSpec,
  SpliceJob,
  SpliceProgress,
  SpliceReport,
  StampEvent,
  StampPreview,
  StampScope,
  StreamNow,
  TagAlbumPlan,
  TagAlbumReceipt,
  TrackDisplay,
  TrackEdit,
  TrackEditFields,
  TrackOverride,
  TrimReplaceJob,
  TrimReplaceResult,
  WriteRecovery,
  TrackPlacement,
  TrackRow,
  VisualizerDefaults,
  WaveformAnalysis,
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

/**
 * Removes a root: its tracks and their memberships are dropped and emptied albums deleted. A root with
 * unfinished file writes rejects with "unfinished writes" unless `dropPendingWrites` forgets them.
 */
export function removeRoot(id: number, dropPendingWrites = false): Promise<void> {
  return invoke("remove_root", { id, dropPendingWrites });
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

/** Offline or all-missing roots whose files look to live under `path`, best match first. Read-only. */
export function relinkCandidates(path: string): Promise<RelinkCandidate[]> {
  return invoke<RelinkCandidate[]>("relink_candidates", { path });
}

/** What pointing root `rootId` at `newPath` would do: a verified move, a merge, or a refusal. Read-only. */
export function previewRelocate(rootId: number, newPath: string): Promise<RelocatePreview> {
  return invoke<RelocatePreview>("preview_relocate", { rootId, newPath });
}

/**
 * Points root `rootId` at `newPath`, keeping its tracks, then rescans it, streaming progress. Resolves
 * with a refusal (nothing changed) or the rescan summary; rejects when the scan lock is held or the
 * rescan after the commit fails.
 */
export function relocateRoot(
  rootId: number,
  newPath: string,
  channel: Channel<ScanProgress>,
): Promise<RelocateOutcome> {
  return invoke<RelocateOutcome>("relocate_root", { rootId, newPath, onProgress: channel });
}

/** What pointing the gone tracks under `folder` of root `rootId` at `newPath` would do. Read-only. */
export function previewLocateFolder(
  rootId: number,
  folder: string,
  newPath: string,
): Promise<LocateFolderPreview> {
  return invoke<LocateFolderPreview>("preview_locate_folder", { rootId, folder, newPath });
}

/**
 * Points the gone tracks under `folder` of root `rootId` at `newPath`, with no rescan. Resolves with a
 * refusal (nothing changed) or the tally; rejects when the scan lock is held.
 */
export function locateFolder(rootId: number, folder: string, newPath: string): Promise<LocateFolderOutcome> {
  return invoke<LocateFolderOutcome>("locate_folder", { rootId, folder, newPath });
}

/** Purges the gone tracks in `trackIds` (only rows the scan flagged gone), resolving with the tally. */
export function removeMissingTracks(trackIds: number[]): Promise<PurgeSummary> {
  return invoke<PurgeSummary>("remove_missing_tracks", { trackIds });
}

/**
 * Queues a background rescan of one root, or of every root when `rootId` is omitted, and resolves at
 * once. Progress and results arrive as `library:*` events.
 */
export function rescanLibrary(rootId?: number): Promise<void> {
  return invoke("rescan_library", { rootId: rootId ?? null });
}

/** The library-sync snapshot: keep-up-to-date on or off, session progress, each root's watch mode. */
export function getLibrarySyncStatus(): Promise<LibrarySyncStatus> {
  return invoke<LibrarySyncStatus>("get_library_sync_status");
}

/** How the present tracks stand for levelling: tagged, measured, unmeasurable and still pending. */
export function loudnessCoverage(): Promise<LoudnessCoverage> {
  return invoke<LoudnessCoverage>("loudness_coverage");
}

/** The rows for `ids`, shaped exactly as `list_tracks` returns them. Missing ids are left out. */
export function getTracksByIds(ids: number[]): Promise<TrackRow[]> {
  return invoke<TrackRow[]>("get_tracks_by_ids", { ids });
}

/** Wraps a progress callback in a fresh channel the export streams ticks over. */
export function createExportChannel(
  onProgress: (progress: ExportProgress) => void,
): Channel<ExportProgress> {
  const channel = new Channel<ExportProgress>();
  channel.onmessage = onProgress;
  return channel;
}

/** The sections, scope and device mode an export run takes beside its target and layout templates. */
export interface ExportOptions {
  albums?: boolean;
  singles?: boolean;
  playlists?: boolean;
  playlistShape?: "mimic" | "file";
  albumIds?: number[];
  deviceInPlace?: boolean;
  changedOnly?: boolean;
}

/**
 * The config an export of `target` sends. A folder target writes straight into its path; a device
 * target leaves `destination` empty and carries the picked target. The one builder behind both the run
 * and its changed-only preview, so the preview reads exactly what the run would write.
 */
export function exportConfig(
  target: ExportTarget,
  folderPattern = "",
  filePattern = "",
  sections: ExportOptions = {},
): ExportConfig {
  return {
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
    // Writes only what changed since the destination's last export; off unless asked for.
    changed_only: sections.changedOnly ?? false,
  };
}

/**
 * Exports the organized library to `target`, streaming progress, resolving with the report. A device
 * target stages the library to a temp folder and transfers it onto the device. The album layout
 * follows `folderPattern`/`filePattern` (token language); left empty, the backend falls back to the
 * shipped default layout. Singles ignore the template.
 */
export function exportLibrary(
  target: ExportTarget,
  channel: Channel<ExportProgress>,
  folderPattern = "",
  filePattern = "",
  sections: ExportOptions = {},
): Promise<ExportSummary> {
  return invoke<ExportSummary>("export_library", {
    config: exportConfig(target, folderPattern, filePattern, sections),
    onProgress: channel,
  });
}

/** Previews a changed-only export of `config`: the files and containers it would write, read-only. */
export function exportChanges(config: ExportConfig): Promise<ExportChangeSet> {
  return invoke<ExportChangeSet>("export_changes", { config });
}

/** Records `config`'s destination as up to date without writing a file; resolves with the file count. */
export function adoptExportDestination(config: ExportConfig): Promise<number> {
  return invoke<number>("adopt_export_destination", { config });
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

/** Whether a remembered destination is still a folder. Creates nothing, unlike the validation. */
export function destinationPresent(destination: string): Promise<boolean> {
  return invoke<boolean>("destination_present", { destination });
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

/** Quits the app from the tray popup, through the guard that warns on a running job first. */
export function quitApp(): Promise<void> {
  return invoke("quit_app");
}

/** The "Quit anyway" path from the running-job warning: cancels every job and exits. */
export function confirmQuit(): Promise<void> {
  return invoke("confirm_quit");
}

/** Summons or dismisses the pop-out now-playing widget, from the mini-player or the tray block. */
export function toggleNowPlayingWidget(): Promise<void> {
  return invoke("toggle_now_playing_widget");
}

/** Dismisses the pop-out now-playing widget, driven by its own close button. */
export function hideNowPlayingWidget(): Promise<void> {
  return invoke("hide_now_playing_widget");
}

/** Pulls the pop-out now-playing widget back inside a monitor's work area and remembers its seat. */
export function settleNowPlayingWidget(): Promise<void> {
  return invoke("settle_now_playing_widget");
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

/**
 * A track's 2-3 dominant cover colours as sRGB triples, for the player's ambient aurora. Null when
 * the track has no cover or the cover is near-gray, which the aurora renders as a neutral tint.
 */
export function getCoverPalette(trackId: number): Promise<[number, number, number][] | null> {
  return invoke<[number, number, number][] | null>("read_cover_palette", { trackId });
}

/**
 * Resolves many albums' covers at `size` in one call: each bound cover, else a member track's art,
 * else null. One entry per id, in the order asked; an unknown id comes back with a null cover.
 */
export function albumCovers(albumIds: number[], size: CoverSize): Promise<AlbumCoverEntry[]> {
  return invoke<AlbumCoverEntry[]>("album_covers", { albumIds, size });
}

/**
 * An album's 2-3 dominant cover colours as sRGB triples, read from the cover the wall shows (the
 * bound one first). Null when the album has no cover or the cover is near-gray.
 */
export function albumCoverPalette(albumId: number): Promise<[number, number, number][] | null> {
  return invoke<[number, number, number][] | null>("album_cover_palette", { albumId });
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

// The backend's StaleProposal message: a batch or receipt no longer fits the library, nothing written.
const STALE_PROPOSAL = "the proposal is out of date";

/** True when an albums-from-tags call was rejected because its plans or receipt went stale. */
export function isStaleProposal(error: unknown): boolean {
  return String(error).includes(STALE_PROPOSAL);
}

// The store's refusal of a membership write issued before albums or playlists have loaded.
const NOT_READY = "albums and playlists have not loaded yet";

/** The rejection a gated store write returns while the projection it writes against has not loaded. */
export function notReadyError(): Error {
  return new Error(NOT_READY);
}

/** True when a store write was refused because albums or playlists have not loaded; nothing was written. */
export function isNotReady(error: unknown): boolean {
  return String(error).includes(NOT_READY);
}

/**
 * Files many groups of loose tracks into new or existing albums in one transaction. Resolves with the
 * receipt that undo and redo replay; rejects the whole batch, writing nothing, when a plan went stale.
 */
export function createAlbumsFromTags(plans: TagAlbumPlan[]): Promise<TagAlbumReceipt> {
  return invoke<TagAlbumReceipt>("create_albums_from_tags", { plans });
}

/** Undoes an albums-from-tags batch from its receipt. Rejects, changing nothing, when it drifted. */
export function revertAlbumsFromTags(receipt: TagAlbumReceipt): Promise<void> {
  return invoke<void>("revert_albums_from_tags", { receipt });
}

/** Redoes a reverted albums-from-tags batch under the same album ids. Rejects when it no longer fits. */
export function reapplyAlbumsFromTags(receipt: TagAlbumReceipt): Promise<void> {
  return invoke<void>("reapply_albums_from_tags", { receipt });
}

/** Deletes an album (or single). Its membership cascades away; the track rows fall back to loose. */
export function deleteAlbum(albumId: number): Promise<void> {
  return invoke("delete_album", { albumId });
}

/** Assigns tracks to an album: a track elsewhere moves here, a loose one is appended, a member stays. */
export function addTracksToAlbum(albumId: number, trackIds: number[]): Promise<void> {
  return invoke("add_tracks_to_album", { albumId, trackIds });
}

/**
 * Sets one member's position within its disc and its keep-own-cover flag. Membership only: the track's
 * edits are untouched.
 */
export function setMemberPlacement(
  albumId: number,
  trackId: number,
  trackNo: number | null,
  keepOwnCover: boolean,
): Promise<void> {
  return invoke("set_member_placement", { albumId, trackId, trackNo, keepOwnCover });
}

/** Removes tracks from an album. They become loose again; their track rows are untouched. */
export function removeTracksFromAlbum(albumId: number, trackIds: number[]): Promise<void> {
  return invoke("remove_tracks_from_album", { albumId, trackIds });
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

/** Reads one track's resolved display title and artist by id, for a webview with no library store. */
export function getTrackDisplay(trackId: number): Promise<TrackDisplay> {
  return invoke<TrackDisplay>("get_track_display", { trackId });
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

/** Appends one startup-read line (failed, timeout, late, recovered) to the boot log. */
export function logBootRead(
  read: "roots" | "tracks" | "organization" | "playlists",
  outcome: "failed" | "timeout" | "late" | "recovered",
  attempt: number,
  elapsedMs: number,
  error: string | null,
): Promise<void> {
  return invoke<void>("log_boot_read", { read, outcome, attempt, elapsedMs, error });
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

/** Opens the Windows Default apps settings page, where the user picks Plisto per file type. A no-op
 * off Windows. */
export function openDefaultAppsSettings(): Promise<void> {
  return invoke("open_default_apps_settings");
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

/**
 * Appends albums as album entries after the playlist's last position, kept in order or not. A single is
 * appended as a track slot of its member.
 */
export function addAlbumsToPlaylist(
  playlistId: number,
  albumIds: number[],
  keepOrder: boolean,
): Promise<void> {
  return invoke("add_albums_to_playlist", { playlistId, albumIds, keepOrder });
}

/** Sets whether an album entry plays its tracks as one block. */
export function setPlaylistEntryKeepOrder(slotId: number, keepOrder: boolean): Promise<void> {
  return invoke("set_playlist_entry_keep_order", { slotId, keepOrder });
}

/** Replaces an album entry by its tracks as slots, in album order and at the entry's place. */
export function unpackPlaylistAlbumEntry(slotId: number): Promise<void> {
  return invoke("unpack_playlist_album_entry", { slotId });
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

// -- Player --
// The native engine is long-lived: these commands poke it and return at once, while the throttled
// `player:status` event carries the live state back. Play args mirror the queue model - a play
// replaces the queue with `trackIds`, cursor at `index`.

/** The player's live snapshot: playing state, playhead, volume, repeat, shuffle and queue cursor. */
export function getPlayerStatus(): Promise<PlayerStatus> {
  return invoke<PlayerStatus>("get_player_status");
}

/** The queue ids in play order with the block spans over them, read from one mirror so the two never disagree. */
export function getPlayerQueueState(): Promise<QueueState> {
  return invoke<QueueState>("get_player_queue_state");
}

/**
 * Replaces the queue with `trackIds` and starts playback at `index` (default the first). `blocks` are
 * `[start, length]` spans over `trackIds` whose tracks play together.
 */
export function playerPlayTracks(
  trackIds: number[],
  index = 0,
  blocks?: QueueBlock[],
): Promise<void> {
  return invoke("player_play_tracks", { trackIds, index, blocks });
}

/**
 * Seats the saved queue paused on `currentId` at `secs`, never playing. `index` names the saved row of the
 * current track, which tells apart two copies of it. Resolves false when the current track no longer
 * exists, in which case nothing is loaded.
 */
export function playerLoad(
  trackIds: number[],
  currentId: number,
  secs: number,
  index?: number,
  blocks?: QueueBlock[],
): Promise<boolean> {
  return invoke<boolean>("player_load", { trackIds, currentId, secs, index, blocks });
}

/** Plays a file straight off disk, with no library row, naming it from its own tags. Rejects when the
 * file cannot be read as audio. */
export function playerPlayFile(path: string): Promise<void> {
  return invoke("player_play_file", { path });
}

/** Plays a set of files straight off disk, with no library rows. Unreadable files drop out; rejects
 * only when every file is unreadable. */
export function playerPlayFiles(paths: string[]): Promise<void> {
  return invoke("player_play_files", { paths });
}

/** Appends a set of files straight off disk to the queue, no library rows: a drop onto a playing player.
 * Unreadable files drop out; rejects only when every file is unreadable. */
export function playerEnqueueFiles(paths: string[]): Promise<void> {
  return invoke("player_enqueue_files", { paths });
}

/** The file paths the OS cold-launched Plisto with, taken once so a reload never replays them, or
 * null when Plisto opened on its own. */
export function getStartupFile(): Promise<string[] | null> {
  return invoke<string[] | null>("get_startup_file");
}

/** The notice from a failed OS-launch open (every file unreadable), taken once, or null. Lets the
 * standalone shell show its refusal body even when the batch's error fired before it subscribed. */
export function getStartupError(): Promise<PlayerNotice | null> {
  return invoke<PlayerNotice | null>("get_startup_error");
}

/** Toggles play/pause on the current track. */
export function playerToggle(): Promise<void> {
  return invoke("player_toggle");
}

/** Pauses the current track, holding the playhead. */
export function playerPause(): Promise<void> {
  return invoke("player_pause");
}

/** Resumes a paused track from the held playhead. */
export function playerResume(): Promise<void> {
  return invoke("player_resume");
}

/** Stops playback and clears the queue. */
export function playerStop(): Promise<void> {
  return invoke("player_stop");
}

/** Empties the parked queue while a plugin stream is seated; the stream keeps playing. Ignored with no stream. */
export function playerClearParked(): Promise<void> {
  return invoke("player_clear_parked");
}

/** The seated plugin stream's display state, or null when none is seated. */
export function getStreamNow(): Promise<StreamNow | null> {
  return invoke<StreamNow | null>("get_stream_now");
}

/** Advances to the next track in the queue. */
export function playerNext(): Promise<void> {
  return invoke("player_next");
}

/** Steps back to the previous track in the queue. */
export function playerPrev(): Promise<void> {
  return invoke("player_prev");
}

/** Jumps straight to the queue slot at `index`, like a click in the up-next list. */
export function playerJump(index: number): Promise<void> {
  return invoke("player_jump", { index });
}

/** Appends `trackIds` to the end of the queue, resolved to files on the backend. `blocks` as in a play. */
export function playerEnqueue(trackIds: number[], blocks?: QueueBlock[]): Promise<void> {
  return invoke("player_enqueue", { trackIds, blocks });
}

/** Inserts `trackIds` right after the playing track (or its block), resolved to files on the backend. */
export function playerPlayNext(trackIds: number[], blocks?: QueueBlock[]): Promise<void> {
  return invoke("player_play_next", { trackIds, blocks });
}

/** Moves the queue item at `from` to `to`, like a drag in the up-next list. */
export function playerMoveQueueItem(from: number, to: number): Promise<void> {
  return invoke("player_move_queue_item", { from, to });
}

/** Removes the queue item at `index`, like a delete in the up-next list. */
export function playerRemoveQueueItem(index: number): Promise<void> {
  return invoke("player_remove_queue_item", { index });
}

/** Seeks the current track to `secs` from its start. */
export function playerSeek(secs: number): Promise<void> {
  return invoke("player_seek", { secs });
}

/**
 * Auditions `path` between `startSecs` and `endSecs` on the resident engine, stopping at the out-point.
 * A transient preview: it leaves the library queue and cursor untouched, so playback restores after.
 */
export function playerPreview(path: string, startSecs: number, endSecs: number): Promise<void> {
  return invoke("player_preview", { path, startSecs, endSecs });
}

/**
 * Reopens the current library track at `secs` and restores its paused state on the resident engine.
 * A preview clears the sink, so a bare resume would play silence; this reseats the library source at
 * the held position with the full queue intact.
 */
export function playerRestoreLibrary(secs: number, playing: boolean): Promise<void> {
  return invoke("player_restore_library", { secs, playing });
}

/** Sets the output volume, 0..1. */
export function playerSetVolume(v: number): Promise<void> {
  return invoke("player_set_volume", { v });
}

/** Sets the repeat mode: off, all, or one. */
export function playerSetRepeat(mode: RepeatMode): Promise<void> {
  return invoke("player_set_repeat", { mode });
}

/** Turns shuffle on or off; the current track keeps playing across the toggle. */
export function playerSetShuffle(on: boolean): Promise<void> {
  return invoke("player_set_shuffle", { on });
}

/**
 * Turns the 128-band `player:spectrum_fine` emit on or off. It rides the same audible gate as the
 * 24-band spectrum and costs a second analysis per frame, so it is on only while a visualizer reads it.
 */
export function playerSetFineSpectrum(on: boolean): Promise<void> {
  return invoke("player_set_fine_spectrum", { on });
}

/**
 * Turns the 256-value `player:wave` snapshot emit on or off. It rides the same audible gate as the
 * spectrum and is on only while a visualizer reads it.
 */
export function playerSetWaveform(on: boolean): Promise<void> {
  return invoke("player_set_waveform", { on });
}

/** Every available output device, each flagged when it is the current OS default. */
export function listOutputDevices(): Promise<OutputDeviceInfo[]> {
  return invoke<OutputDeviceInfo[]>("list_output_devices");
}

/** Picks the output device: a name pins it, null follows the system default. */
export function playerSetOutputDevice(name: string | null): Promise<void> {
  return invoke("player_set_output_device", { name });
}

// -- Play history --
// The engine records each counted listen into a `plays` log; these read it back and reset it. The
// reads return ordered track ids, hydrated against the in-memory library store.

/** Clears play history: a track id wipes just that track's plays, omitted wipes the whole log. */
export function resetPlayHistory(trackId?: number): Promise<void> {
  return invoke("reset_play_history", { trackId });
}

/** The most recently played track ids, most recent first, one per track. */
export function getRecentlyPlayed(limit: number): Promise<number[]> {
  return invoke<number[]>("get_recently_played", { limit });
}

/**
 * The most played track ids by weighted score, highest first. `since` (unix seconds) windows the count
 * to recent plays; omit it for all-time.
 */
export function getMostPlayed(limit: number, since?: number): Promise<number[]> {
  return invoke<number[]>("get_most_played", { limit, since });
}

/**
 * The deduped last-play rows for the History surface, newest last-play first. `limit` caps the list;
 * undefined returns the whole history.
 */
export function getRecentlyPlayedRows(limit?: number): Promise<HistoryRow[]> {
  return invoke<HistoryRow[]>("get_recently_played_rows", { limit });
}

/**
 * The raw play-count ranking rows for the History surface, most plays first. `limit` caps the list;
 * undefined returns the whole history. `since` (unix seconds) windows the count to recent plays; omit
 * it for all-time.
 */
export function getMostPlayedRows(limit?: number, since?: number): Promise<HistoryRow[]> {
  return invoke<HistoryRow[]>("get_most_played_rows", { limit, since });
}

/**
 * The raw play-log timeline for the History surface, every play newest first, not deduped - a track
 * repeats once per listen. `limit` caps the list; undefined returns the whole log.
 */
export function getPlayTimeline(limit?: number): Promise<PlayEvent[]> {
  return invoke<PlayEvent[]>("get_play_timeline", { limit });
}

/** Reads every stored visualizer default, albums and tracks. */
export function getVisualizerDefaults(): Promise<VisualizerDefaults> {
  return invoke<VisualizerDefaults>("get_visualizer_defaults");
}

/** Sets one album's default visualizer kind, or clears it with null. */
export function setAlbumVisualizer(albumId: number, kind: string | null): Promise<void> {
  return invoke<void>("set_album_visualizer", { albumId, kind });
}

/** Sets one track's default visualizer kind, or clears it with null. */
export function setTrackVisualizer(trackId: number, kind: string | null): Promise<void> {
  return invoke<void>("set_track_visualizer", { trackId, kind });
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

// -- Duplicates --
// Detection runs in the frontend; these persist its outcome. A merge returns the receipt its undo
// sends back as-is.

/** Marks every pair among the tracks as not duplicates. A pair already dismissed is left as is. */
export function dismissDuplicates(trackIds: number[]): Promise<void> {
  return invoke("dismiss_duplicates", { trackIds });
}

/** Clears every dismissed pair among the tracks. */
export function undismissDuplicates(trackIds: number[]): Promise<void> {
  return invoke("undismiss_duplicates", { trackIds });
}

/** Every dismissed pair, lower id first. */
export function listDuplicateDismissals(): Promise<DismissedPair[]> {
  return invoke<DismissedPair[]>("list_duplicate_dismissals");
}

/**
 * Folds the duplicates into the keeper: their playlist slots, plays and album place move to it, and
 * the group is dismissed. Rejects, changing nothing, while a scan runs or when the merge is refused.
 */
export function mergeDuplicates(keeperId: number, discardIds: number[]): Promise<MergeReceipt> {
  return invoke<MergeReceipt>("merge_duplicates", { keeperId, discardIds });
}

/** Undoes a merge from its receipt. Rejects, changing nothing, when its rows moved since. */
export function undoMergeDuplicates(receipt: MergeReceipt): Promise<void> {
  return invoke<void>("undo_merge_duplicates", { receipt });
}

// The backend's MergeError::Stale message: a receipt's rows moved since the merge, nothing written.
const STALE_MERGE = "the library changed since the merge";

/** True when a merge undo was refused because the library moved on since the merge. */
export function isStaleMerge(error: unknown): boolean {
  return String(error).includes(STALE_MERGE);
}

// -- Splicer / cropper --
// analyze/detect drain the source on blocking threads; splice_run cuts segments sequentially. Progress
// rides per-invocation channels, matching the export wiring; splice_cancel signals a running run to stop.

/** Wraps a progress callback in a fresh channel the analysis streams frame-decode ticks over. */
export function createAnalyzeChannel(
  onProgress: (progress: AnalyzeProgress) => void,
): Channel<AnalyzeProgress> {
  const channel = new Channel<AnalyzeProgress>();
  channel.onmessage = onProgress;
  return channel;
}

/** Wraps a progress callback in a fresh channel the splice streams ticks over. */
export function createSpliceChannel(
  onProgress: (progress: SpliceProgress) => void,
): Channel<SpliceProgress> {
  const channel = new Channel<SpliceProgress>();
  channel.onmessage = onProgress;
  return channel;
}

/**
 * Analyzes the file at `path` into `buckets` waveform peaks and its silence spans, streaming decode
 * progress over `channel` and resolving with the analysis.
 */
export function spliceAnalyze(
  path: string,
  buckets: number,
  thresholdDb: number,
  minSilenceSecs: number,
  onProgress: Channel<AnalyzeProgress>,
): Promise<WaveformAnalysis> {
  return invoke<WaveformAnalysis>("splice_analyze", {
    path,
    buckets,
    thresholdDb,
    minSilenceSecs,
    onProgress,
  });
}

/** Re-runs silence detection over `path` with a fresh threshold and minimum length, returning the spans. */
export function spliceDetectSilence(
  path: string,
  thresholdDb: number,
  minSilenceSecs: number,
): Promise<SilenceSpan[]> {
  return invoke<SilenceSpan[]>("splice_detect_silence", { path, thresholdDb, minSilenceSecs });
}

/** Parses the cue sheet at `path` into its disc performer and tracks. A pure read. */
export function spliceParseCue(path: string): Promise<CueSheet> {
  return invoke<CueSheet>("splice_parse_cue", { path });
}

/**
 * Cuts `job.segments` out of the source into `job.destination`, streaming progress over `channel` and
 * resolving with the report. Cancellable through `spliceCancel`.
 */
export function spliceRun(
  job: SpliceJob,
  onProgress: Channel<SpliceProgress>,
): Promise<SpliceReport> {
  return invoke<SpliceReport>("splice_run", { job, onProgress });
}

/** Signals the running splice to stop. The backend finishes its current segment and reports cancelled. */
export function spliceCancel(): Promise<void> {
  return invoke("splice_cancel");
}

/** Every plugin registry entry with its state and, for one that failed a boot check, the reason. */
export function pluginsList(): Promise<PluginRow[]> {
  return invoke<PluginRow[]>("plugins_list");
}

/** The runtime gate (held, running or safe) and what the previous run left behind. */
export function pluginsBootState(): Promise<PluginBootState> {
  return invoke<PluginBootState>("plugins_boot_state");
}

/** The frame base URL for an enabled plugin, or null when frames are unavailable or it is not enabled. */
export function pluginFrameUrl(id: string): Promise<string | null> {
  return invoke<string | null>("plugin_frame_url", { id });
}

/**
 * The URL a declared visualizer kind of an enabled plugin loads from its visualizer host. Rejects
 * when frames are unavailable, the plugin is not enabled, or it declares no such kind.
 */
export function pluginVisUrl(id: string, kind: string): Promise<string> {
  return invoke<string>("plugin_vis_url", { id, kind });
}

/**
 * Reports the visualizer hosts (`pv-<hash>.invalid`, the hostname of a kind's URL) whose frames
 * are shown. Call it whenever that set changes, with the union of every visible visualizer frame:
 * the stage and any previews, and again every few seconds while any visualizer frame is mounted, so
 * a frame whose process the watch tracks after the last change still gets a report. A renderer is
 * ended for load only after a valid report has arrived since the watch began tracking it, and never
 * while one of its hosts was in a report since its last sample. A report with any other host
 * rejects, and nothing is ended until the next valid one.
 */
export function pluginVisShown(hosts: string[]): Promise<void> {
  return invoke<void>("plugin_vis_shown", { hosts });
}

/** Every plugin visualizer kind with a fault mark or a turned-back-on record, for all plugins at once. */
export function pluginVisMarks(): Promise<PluginVisKindState[]> {
  return invoke<PluginVisKindState[]>("plugin_vis_marks");
}

/** Marks a kind as flashing or as having lost its graphics context, under its current build key. */
export function pluginVisMark(id: string, kind: string, mark: PluginVisMark): Promise<void> {
  return invoke<void>("plugin_vis_mark", { id, kind, mark });
}

/** Removes a kind's fault marks and records it as turned back on under its current build key. */
export function pluginVisClearMark(id: string, kind: string): Promise<void> {
  return invoke<void>("plugin_vis_clear_mark", { id, kind });
}

/**
 * Writes the graphics-reset trial marker for a kind and resolves true; a marker still there at next
 * launch becomes a mark. Resolves false, writing nothing, when the kind already passed under its build.
 */
export function pluginVisTrialBegin(id: string, kind: string): Promise<boolean> {
  return invoke<boolean>("plugin_vis_trial_begin", { id, kind });
}

/**
 * Removes the graphics-reset trial marker for a kind. `passed` records the kind as trialed under its
 * build; false (the kind unmounted early) only removes the marker.
 */
export function pluginVisTrialEnd(id: string, kind: string, passed: boolean): Promise<void> {
  return invoke<void>("plugin_vis_trial_end", { id, kind, passed });
}

/**
 * Stores a kind's still. The PNG is the raw body (at most 1 MiB); the ids travel as headers, which
 * Tauri forwards with a raw payload.
 */
export function pluginVisThumbPut(
  id: string,
  kind: string,
  theme: PluginVisTheme,
  png: Uint8Array,
): Promise<void> {
  const headers = { "x-vis-id": id, "x-vis-kind": kind, "x-vis-theme": theme };
  return invoke<void>("plugin_vis_thumb_put", png, { headers });
}

/**
 * Saves a developer-mode feed recording under the plugin's data folder and resolves with the file's
 * path. The recording is the raw body (at most 8 MiB); the ids travel as headers. Rejects with a
 * PluginVisRecordError.
 */
export function pluginVisRecordSave(id: string, kindId: string, json: string): Promise<string> {
  const headers = { "x-vis-id": id, "x-vis-kind": kindId };
  return invoke<string>("plugin_vis_record_save", new TextEncoder().encode(json), { headers });
}

/** A kind's stored still as PNG bytes, or null when none is stored under its current build key. */
export async function pluginVisThumbGet(
  id: string,
  kind: string,
  theme: PluginVisTheme,
): Promise<ArrayBuffer | null> {
  const bytes = await invoke<ArrayBuffer>("plugin_vis_thumb_get", { id, kind, theme });
  return bytes.byteLength === 0 ? null : bytes;
}

/** Stages and checks a plugin folder or `.plistoplugin` file. Rejects with `{ code, detail }`. */
export function pluginInspect(path: string): Promise<PluginInspection> {
  return invoke<PluginInspection>("plugin_inspect", { path });
}

/**
 * Installs an inspected plugin, turned off and needing consent. `clearData` deletes the data saved under
 * the same id first, so the plugin does not inherit it. Returns its row.
 */
export function pluginInstall(token: string, clearData: boolean): Promise<PluginRow> {
  return invoke<PluginRow>("plugin_install", { token, clearData });
}

/** Drops an inspected plugin and its staged copy. */
export function pluginDiscard(token: string): Promise<void> {
  return invoke<void>("plugin_discard", { token });
}

/** The folders and `.plistoplugin` files waiting in the plugins inbox. */
export function pluginInbox(): Promise<PluginInboxItem[]> {
  return invoke<PluginInboxItem[]>("plugin_inbox");
}

/**
 * Turns a plugin on. A plugin that needs consent takes `grants` (exactly its declared capabilities),
 * `manifestHash` (the manifest the sheet showed) and, when native, `nativeAck`. Returns its row.
 */
export function pluginEnable(
  id: string,
  grants?: string[],
  nativeAck?: boolean,
  manifestHash?: string,
): Promise<PluginRow> {
  return invoke<PluginRow>("plugin_enable", { id, grants, nativeAck, manifestHash });
}

/** Turns a plugin off, keeping its consent. Returns its row. */
export function pluginDisable(id: string): Promise<PluginRow> {
  return invoke<PluginRow>("plugin_disable", { id });
}

/** Replaces an installed plugin with an inspected one. */
export function pluginUpdate(token: string): Promise<PluginUpdated> {
  return invoke<PluginUpdated>("plugin_update", { token });
}

/** Removes a plugin's code, and its saved data when `deleteData` is set. */
export function pluginUninstall(id: string, deleteData: boolean): Promise<PluginUninstalled> {
  return invoke<PluginUninstalled>("plugin_uninstall", { id, deleteData });
}

/** An installed plugin's icon as a `data:` URL, or null when it has none or it cannot be read. */
export function pluginIcon(id: string): Promise<string | null> {
  return invoke<string | null>("plugin_icon", { id });
}

/** A staged plugin's icon as a `data:` URL, or null when it has none or it cannot be read. */
export function pluginStagedIcon(token: string): Promise<string | null> {
  return invoke<string | null>("plugin_staged_icon", { token });
}

/** Sets whether a plugin's sidebar section is folded. Returns its row. */
export function pluginSetSidebarCollapsed(id: string, collapsed: boolean): Promise<PluginRow> {
  return invoke<PluginRow>("plugin_set_sidebar_collapsed", { id, collapsed });
}

/**
 * Records consent for an installed plugin and leaves it ready and off. Takes the same arguments as
 * `pluginEnable`. Returns its row.
 */
export function pluginApprove(
  id: string,
  grants: string[],
  nativeAck: boolean | undefined,
  manifestHash: string,
): Promise<PluginRow> {
  return invoke<PluginRow>("plugin_approve", { id, grants, nativeAck, manifestHash });
}

/** The plugins inbox folder, created if missing. */
export function pluginInboxPath(): Promise<string> {
  return invoke<string>("plugin_inbox_path");
}

/** Bytes of saved data a plugin holds; 0 when it has saved nothing. */
export function pluginDataSize(id: string): Promise<number> {
  return invoke<number>("plugin_data_size", { id });
}

/** Whether developer mode is on. */
export function pluginsDevMode(): Promise<boolean> {
  return invoke<boolean>("plugins_dev_mode");
}

/** Turns developer mode on or off. Resolves the saved value. */
export function pluginSetDevMode(on: boolean): Promise<boolean> {
  return invoke<boolean>("plugin_set_dev_mode", { on });
}

/** Re-installs a plugin from the source it was installed from, as an update. */
export function pluginReload(id: string): Promise<PluginUpdated> {
  return invoke<PluginUpdated>("plugin_reload", { id });
}

/** The last lines of a plugin's log and, for a native plugin, of its stderr log. */
export function pluginLogTail(id: string): Promise<PluginLogTail> {
  return invoke<PluginLogTail>("plugin_log_tail", { id });
}

/** Runs one plugin API call. Always resolves a reply; a rejection means the call never reached Rust. */
export function pluginCall(id: string, method: string, args: string): Promise<PluginCallReply> {
  return invoke<PluginCallReply>("plugin_call", { id, method, args });
}

/**
 * Runs one framed `net.fetch` request and resolves the framed reply. A rejection means the request never
 * reached Rust.
 */
export function pluginFetch(payload: Uint8Array): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("plugin_fetch", payload);
}

/** The last requests Plisto made for a plugin, held in memory only. */
export function pluginNetLog(id: string): Promise<PluginNetLogEntry[]> {
  return invoke<PluginNetLogEntry[]>("plugin_net_log", { id });
}

/** Whether Windows is set to use a proxy on the current network. */
export function pluginNetEnvironment(): Promise<PluginNetEnvironment> {
  return invoke<PluginNetEnvironment>("plugin_net_environment");
}

/** Opens the loopback listeners the sandbox self-check aims its WebRTC traffic at. */
export function sandboxCheckOpen(): Promise<SandboxCheckSinks> {
  return invoke<SandboxCheckSinks>("sandbox_check_open");
}

/** Closes the listeners and returns how much traffic reached them. */
export function sandboxCheckClose(token: string): Promise<SandboxCheckCounts> {
  return invoke<SandboxCheckCounts>("sandbox_check_close", { token });
}

/** Reports whether a plugin's page is the shown destination with its frame live. */
export function pluginPageState(id: string, open: boolean): Promise<void> {
  return invoke<void>("plugin_page_state", { id, open });
}

/** Answers an open plugin toast or prompt. False when the request is gone or the kind does not match. */
export function pluginUiAnswer(requestId: string, answer: PluginUiAnswer): Promise<boolean> {
  return invoke<boolean>("plugin_ui_answer", { requestId, answer });
}

/** The toasts and prompts Rust still holds open, in arrival order. */
export function pluginUiPending(): Promise<PluginUiEvent[]> {
  return invoke<PluginUiEvent[]>("plugin_ui_pending");
}

/** The live sidebar state of every serving plugin. */
export function pluginSidebarState(): Promise<PluginSidebarSnapshot[]> {
  return invoke<PluginSidebarSnapshot[]>("plugin_sidebar_state");
}

/** Reports a click on a toggle (`value` set) or an action (`value` null); the reply carries the frame delivery. */
export function pluginSidebarInput(
  id: string,
  itemId: string,
  value: boolean | null,
): Promise<PluginSidebarInputReply> {
  return invoke<PluginSidebarInputReply>("plugin_sidebar_input", { id, itemId, value });
}

/**
 * Tells Rust how a plugin's frame stands: live, not responding, crashed (with `reason`) or detached. A
 * crash or detach also frees that plugin's open toasts and prompts.
 */
export function pluginFrameEvent(
  id: string,
  kind: PluginFrameEventKind,
  reason?: PluginFrameCrashReason,
): Promise<void> {
  return invoke<void>("plugin_frame_event", { id, kind, reason: reason ?? null });
}

/** Reports a library change to the plugin event hub. A rejection means it never reached Rust. */
export function pluginLibraryChanged(change: LibraryChange): Promise<void> {
  return invoke<void>("plugin_library_changed", {
    trackIds: change.track_ids,
    albums: change.albums,
    playlists: change.playlists,
  });
}

/** Answers the held runtime: `safe` starts the session without plugins. Returns the resulting boot view. */
export function pluginsResolveBoot(safe: boolean): Promise<PluginBootState> {
  return invoke<PluginBootState>("plugins_resolve_boot", { safe });
}

/** Restarts Plisto, with every plugin off for the next session when `safe`. Resolves only if it did not restart. */
export function pluginsRestart(safe: boolean): Promise<void> {
  return invoke<void>("plugins_restart", { safe });
}

/** Stops every plugin process before an update replaces the app. */
export function pluginsShutdownForUpdate(): Promise<void> {
  return invoke<void>("plugins_shutdown_for_update");
}

/** Starts the plugins again after an update that did not install. */
export function pluginsResumeAfterUpdate(): Promise<void> {
  return invoke<void>("plugins_resume_after_update");
}

/** The status of every serving plugin; empty while the runtime is not running. */
export function pluginStatuses(): Promise<PluginStatus[]> {
  return invoke<PluginStatus[]>("plugin_statuses");
}

/** Takes the output back from whichever plugin holds it; true when a holder was released. */
export function pluginTakeoverRelease(): Promise<boolean> {
  return invoke<boolean>("plugin_takeover_release");
}

/** Restarts a serving plugin with a fresh crash count. */
export function pluginRestart(id: string): Promise<void> {
  return invoke<void>("plugin_restart", { id });
}

/** One page of recorded read failures in folder-then-name order; `reason` narrows `total` and the rows. */
export function scanIssuesList(
  offset: number,
  limit: number,
  reason: ScanIssueReason | null,
): Promise<ScanIssuePage> {
  return invoke<ScanIssuePage>("scan_issues_list", { offset, limit, reason });
}

/** The standing number of recorded read failures. */
export function scanIssuesCount(): Promise<number> {
  return invoke<number>("scan_issues_count");
}

/**
 * Re-reads the issues named by `ids`, else those of `reason`, else all. Rejects with "a scan is already
 * running" during a user scan.
 */
export function scanIssuesRetry(
  ids: number[] | null,
  reason: ScanIssueReason | null,
): Promise<ScanIssueRetryResult> {
  return invoke<ScanIssueRetryResult>("scan_issues_retry", { ids, reason });
}

/** The list as one plain-text block for the clipboard, narrowed by `reason`. English whatever the locale. */
export function scanIssuesText(reason: ScanIssueReason | null): Promise<string> {
  return invoke<string>("scan_issues_text", { reason });
}

/** Dismisses the issues named by `ids`, else those of `reason`, else all; returns how many it dismissed. */
export function scanIssuesClear(
  ids: number[] | null,
  reason: ScanIssueReason | null,
): Promise<number> {
  return invoke<number>("scan_issues_clear", { ids, reason });
}

/** Opens the scan log in the default app. False when no log file exists yet. */
export function scanIssuesOpenLog(): Promise<boolean> {
  return invoke<boolean>("scan_issues_open_log");
}

// -- Restore points --

/** Every restore point, newest first, with the folder's disk use. */
export function listRestorePoints(): Promise<RestorePointList> {
  return invoke<RestorePointList>("list_restore_points");
}

/** What restoring the point `file` would bring back and lose. Writes nothing. */
export function planRestore(file: string): Promise<RestorePreview> {
  return invoke<RestorePreview>("plan_restore", { file });
}

/**
 * Replaces the library's organization with the point `file`, after saving a point of the library as it
 * is. A refusal changes nothing.
 */
export function restoreFromPoint(file: string): Promise<RestoreOutcome> {
  return invoke<RestoreOutcome>("restore_from_point", { file });
}

/**
 * Saves a restore point before a multi-item action. Resolves true when it was saved; a refused action
 * key rejects.
 */
export function takePointBefore(action: "delete_albums"): Promise<boolean> {
  return invoke<boolean>("take_point_before", { action });
}

// -- Writing to music files --
// Batches stream a StampEvent per file over a per-invocation channel; each re-read file also fires the
// existing library delta. The write commands refuse with "a file write is running" while one holds the lock.

/** Wraps an event callback in a fresh channel a tag-write batch streams its events over. */
export function createStampChannel(onEvent: (event: StampEvent) => void): Channel<StampEvent> {
  const channel = new Channel<StampEvent>();
  channel.onmessage = onEvent;
  return channel;
}

/** What startup or a scan did about writes an earlier run left unfinished. Takes and clears it. */
export function takeFileWriteRecovery(): Promise<WriteRecovery> {
  return invoke<WriteRecovery>("take_file_write_recovery");
}

/** The latest batch that wrote a file, or null before the first. */
export function lastFileWrite(): Promise<LastFileWrite> {
  return invoke<LastFileWrite>("last_file_write");
}

/** The files under `rootId` with an unfinished write, as absolute paths. */
export function pendingWrites(rootId: number): Promise<string[]> {
  return invoke<string[]>("pending_writes", { rootId });
}

/** How many files in `scope` differ from what Plisto shows. A read on its own connection. */
export function stampDifferCount(scope: StampScope): Promise<{ files: number }> {
  return invoke<{ files: number }>("stamp_differ_count", { scope });
}

/** The dry run of a tag write over `scope`. Writes nothing; the snapshot it names is what a run commits. */
export function stampPreview(scope: StampScope): Promise<StampPreview> {
  return invoke<StampPreview>("stamp_preview", { scope });
}

/** Writes the previewed batch, streaming one event per file and ending with the summary. */
export function stampRun(previewId: string, onEvent: Channel<StampEvent>): Promise<void> {
  return invoke("stamp_run", { previewId, onEvent });
}

/** Stops the running batch after the file it is on. */
export function stampCancel(): Promise<void> {
  return invoke("stamp_cancel");
}

/** Writes `trackIds` again inside the batch `batchId`, so one undo covers the run and its retries. */
export function stampRetry(batchId: number, trackIds: number[], onEvent: Channel<StampEvent>): Promise<void> {
  return invoke("stamp_retry", { batchId, trackIds, onEvent });
}

/** Puts back what the batch `batchId` wrote, field by field, streaming one event per file. */
export function stampUndo(batchId: number, onEvent: Channel<StampEvent>): Promise<void> {
  return invoke("stamp_undo", { batchId, onEvent });
}

/**
 * Trims a library track in place, keeping its original as a hidden backup. Rejects with a failure
 * detail the front end maps to a TrimFailure, or with the TrimCancelled code after
 * `trimReplaceCancel`, which only stops it before the swap.
 */
export function trimReplace(job: TrimReplaceJob, onProgress: Channel<SpliceProgress>): Promise<TrimReplaceResult> {
  return invoke<TrimReplaceResult>("trim_replace", { job, onProgress });
}

/** Signals the running in-place trim to stop. Only effective before the swap. */
export function trimReplaceCancel(): Promise<void> {
  return invoke("trim_replace_cancel");
}

/** Puts the kept original of `undoId` back. Rejects with a TrimFailure, `changed` for an edited file. */
export function trimUndo(undoId: number): Promise<void> {
  return invoke("trim_undo", { undoId });
}

/** Every kept backup with where it stands. A read. */
export function keptBackupsList(): Promise<KeptBackup[]> {
  return invoke<KeptBackup[]>("kept_backups_list");
}

/** Deletes one kept backup. Refused when its folder is offline. */
export function keptBackupDiscard(undoId: number): Promise<KeptDiscardOutcome> {
  return invoke<KeptDiscardOutcome>("kept_backup_discard", { undoId });
}

/** Deletes every kept backup it can reach; rows on an offline folder are skipped and counted. */
export function keptBackupsDiscardAll(): Promise<KeptDiscardAllOutcome> {
  return invoke<KeptDiscardAllOutcome>("kept_backups_discard_all");
}
