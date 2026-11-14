/*
 * Types for plisto-sdk.js, protocol 1. Include this file in a TypeScript project to type window.plisto.
 * PlistoMethods lists every method of this API version: one quoted key per line.
 */

export type PlistoErrorCode =
  | "denied"
  | "rate_limited"
  | "invalid_args"
  | "too_large"
  | "not_found"
  | "unknown_method"
  | "busy"
  | "timeout"
  | "unavailable";

export type PlistoLocale = "en" | "fr" | (string & {});
export type PlistoTheme = "light" | "dark";
export type PlistoAppMode = "player" | "organizer" | "both";
export type PlistoLogLevel = "debug" | "info" | "warn" | "error";

export interface AppInfo {
  api_version: number;
  plisto_version: string;
  plugin_id: string;
  plugin_version: string;
  locale: PlistoLocale;
  theme: PlistoTheme;
  app_mode: PlistoAppMode;
  tier: "ui" | "native";
  granted: string[];
}

export interface AppMethodsResult {
  api_version: number;
  methods: string[];
}

export interface StorageGetArgs {
  key: string;
}
export interface StorageGetResult {
  found: boolean;
  value: unknown;
}
export interface StorageSetArgs {
  key: string;
  value: unknown;
}
export interface StorageSetResult {
  usage: number;
}
export interface StorageRemoveArgs {
  key: string;
}
export interface StorageRemoveResult {
  removed: boolean;
  usage: number;
}
export interface StorageKeysArgs {
  prefix?: string;
}
export interface StorageKeysResult {
  keys: string[];
}
export interface StorageClearResult {
  usage: number;
}
export interface StorageUsageResult {
  usage: number;
  quota: number;
}
export interface LogWriteArgs {
  level: PlistoLogLevel;
  text: string;
}
export interface LogWriteResult {
  truncated: boolean;
}

export type PlistoTone = "neutral" | "accent" | "warn";
export type EmptyResult = Record<string, never>;

/** One chip: exactly one of `text` (1 to 12 characters) and `count` (an integer from 0 to 2147483647). */
export interface PlistoChipInput {
  text?: string;
  count?: number;
  /** Default "neutral". */
  tone?: PlistoTone;
}

export interface UiToastArgs {
  /** Plain text, 1 to 140 characters. */
  text: string;
  /** Label of an optional action button, 1 to 24 characters. */
  action?: string;
}
export type UiToastResult = { result: "dismissed" } | { result: "action"; gesture: string };

export interface UiConfirmArgs {
  /** 1 to 60 characters. */
  title: string;
  /** 1 to 300 characters. */
  body: string;
  /** 1 to 24 characters. */
  confirm_label: string;
  /** 1 to 24 characters; Plisto's own "Cancel" when left out. */
  cancel_label?: string;
  /** A token from a recent click; lets a background page ask while its page is closed. */
  gesture?: string;
}
export interface UiConfirmResult {
  answer: boolean;
}

export interface UiChipsArgs {
  /** At most 2; an empty array clears. */
  chips: PlistoChipInput[];
}

export interface UiOpenPageArgs {
  /** 1 to 64 visible ASCII characters, or null for the page's start. */
  route?: string | null;
  gesture?: string;
}

/** `label: null` keeps the label declared in the manifest. */
export interface NavStateInput {
  label?: string | null;
  chip?: PlistoChipInput | null;
  visible?: boolean;
}
export interface StatusStateInput {
  /** 1 to 40 characters. */
  text: string;
  tone?: PlistoTone;
  visible?: boolean;
}
export interface ProgressStateInput {
  /** 0 to 1 inclusive; null shows an indeterminate sweep. */
  value: number | null;
  /** Up to 40 characters; null shows the declared label. */
  text?: string | null;
  visible?: boolean;
}
export interface ToggleStateInput {
  on: boolean;
  /** Default true. */
  enabled?: boolean;
  visible?: boolean;
}
export interface ActionStateInput {
  label?: string | null;
  /** Default true. */
  enabled?: boolean;
  visible?: boolean;
}
/** The state of one item, matching the item's declared type. An update replaces the whole state. */
export type SidebarStateInput =
  | NavStateInput
  | StatusStateInput
  | ProgressStateInput
  | ToggleStateInput
  | ActionStateInput;

export interface UiSidebarUpdateArgs {
  item_id: string;
  state: SidebarStateInput;
}

/** A click on one of the plugin's toggle or action items. `value` is null for an action. */
export interface SidebarInput {
  item_id: string;
  value: boolean | null;
  /** Single-use token, valid for 5 seconds; pass it to ui.confirm or ui.open_page. */
  gesture: string;
}

/** A library track, resolved as Plisto shows it. Tracks missing on disk never appear. */
export interface PlistoTrack {
  id: number;
  title: string | null;
  artist: string | null;
  /** A track in an album shows the album's title, album artist and year; otherwise its own. */
  album: string | null;
  album_artist: string | null;
  year: number | null;
  track_no: number | null;
  disc_no: number | null;
  duration_secs: number | null;
  genres: string[];
  /** The album or single the track is filed into. */
  album_id: number | null;
}

export interface PlistoAlbum {
  id: number;
  kind: "album" | "single";
  title: string | null;
  album_artist: string | null;
  year: number | null;
  /** Members present on disk. */
  track_count: number;
}

export interface PlistoPlaylist {
  id: number;
  name: string | null;
  description: string | null;
  /** Slots whose track is present on disk. */
  track_count: number;
}

/** One page of a list. Pass `next_cursor` as `cursor` for the next page; null means this was the last. */
export interface PlistoPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface PageArgs<S extends string> {
  /** The list's first sort when left out. */
  sort?: S;
  /** The `next_cursor` of the previous page of the same list, sort and container. */
  cursor?: string | null;
  /** 1 to 200; default 50. */
  limit?: number;
}

export type LibraryTracksArgs = PageArgs<"id" | "title" | "artist">;
export interface LibraryTracksByIdArgs {
  /** At most 200. */
  ids: number[];
}
export interface LibraryTracksByIdResult {
  items: PlistoTrack[];
}
export interface LibraryAlbumsArgs extends PageArgs<"id" | "title" | "artist"> {
  kind?: "album" | "single" | null;
}
export interface LibraryIdArgs {
  id: number;
}
export interface LibraryContainerTracksArgs extends PageArgs<"position"> {
  id: number;
}
export type LibraryPlaylistsArgs = PageArgs<"id" | "name">;
export interface LibraryCoverArgs {
  kind: "track" | "album" | "playlist";
  id: number;
  /** Longest edge 128, 256 or 512 pixels. */
  size: "thumb" | "grid" | "detail";
}
export interface LibraryCoverResult {
  /** A `data:image/jpeg;base64,...` URL, or null when there is no cover. */
  data_url: string | null;
}

export type PlistoRepeat = "off" | "all" | "one";

export interface PlaybackState {
  playing: boolean;
  /** Null when nothing is loaded or the track was opened straight from a file. */
  track_id: number | null;
  /** Null as for track_id, and for a track missing on disk. */
  track: PlistoTrack | null;
  position_secs: number;
  duration_secs: number;
  /** 0 to 1. */
  volume: number;
  repeat: PlistoRepeat;
  shuffle: boolean;
  queue_index: number;
  queue_length: number;
}
export interface PlaybackQueueResult {
  /** In play order; null for a track opened straight from a file. */
  track_ids: (number | null)[];
  index: number;
}
export interface PlaybackSeekArgs {
  /** At least 0. */
  secs: number;
}

/** Exactly one of the three. Tracks missing on disk are left out. */
export type QueueSource =
  | { track_ids: number[]; album_id?: null; playlist_id?: null }
  | { album_id: number; track_ids?: null; playlist_id?: null }
  | { playlist_id: number; track_ids?: null; album_id?: null };
/** `start` indexes the source as given; default 0. */
export type QueuePlayArgs = QueueSource & { start?: number };
export interface QueueResult {
  /** How many tracks went to the player; 0 sends nothing. */
  queued: number;
}

export interface PlistoMethods {
  "app.info": { args: {}; result: AppInfo };
  "app.methods": { args: {}; result: AppMethodsResult };
  "storage.get": { args: StorageGetArgs; result: StorageGetResult };
  "storage.set": { args: StorageSetArgs; result: StorageSetResult };
  "storage.remove": { args: StorageRemoveArgs; result: StorageRemoveResult };
  "storage.keys": { args: StorageKeysArgs; result: StorageKeysResult };
  "storage.clear": { args: {}; result: StorageClearResult };
  "storage.usage": { args: {}; result: StorageUsageResult };
  "log.write": { args: LogWriteArgs; result: LogWriteResult };
  "ui.toast": { args: UiToastArgs; result: UiToastResult };
  "ui.confirm": { args: UiConfirmArgs; result: UiConfirmResult };
  "ui.open_page": { args: UiOpenPageArgs; result: EmptyResult };
  "ui.chips": { args: UiChipsArgs; result: EmptyResult };
  "ui.sidebar.update": { args: UiSidebarUpdateArgs; result: EmptyResult };
  "library.tracks": { args: LibraryTracksArgs; result: PlistoPage<PlistoTrack> };
  "library.tracks_by_id": { args: LibraryTracksByIdArgs; result: LibraryTracksByIdResult };
  "library.albums": { args: LibraryAlbumsArgs; result: PlistoPage<PlistoAlbum> };
  "library.album": { args: LibraryIdArgs; result: PlistoAlbum };
  "library.album_tracks": { args: LibraryContainerTracksArgs; result: PlistoPage<PlistoTrack> };
  "library.playlists": { args: LibraryPlaylistsArgs; result: PlistoPage<PlistoPlaylist> };
  "library.playlist": { args: LibraryIdArgs; result: PlistoPlaylist };
  "library.playlist_tracks": { args: LibraryContainerTracksArgs; result: PlistoPage<PlistoTrack> };
  "library.cover": { args: LibraryCoverArgs; result: LibraryCoverResult };
  "playback.state": { args: {}; result: PlaybackState };
  "playback.queue": { args: {}; result: PlaybackQueueResult };
  "playback.toggle": { args: {}; result: EmptyResult };
  "playback.pause": { args: {}; result: EmptyResult };
  "playback.resume": { args: {}; result: EmptyResult };
  "playback.next": { args: {}; result: EmptyResult };
  "playback.prev": { args: {}; result: EmptyResult };
  "playback.seek": { args: PlaybackSeekArgs; result: EmptyResult };
  "queue.play": { args: QueuePlayArgs; result: QueueResult };
  "queue.add": { args: QueueSource; result: QueueResult };
  "queue.play_next": { args: QueueSource; result: QueueResult };
}

export interface CallOptions {
  /** 1 to 600000; default 10000. */
  timeoutMs?: number;
}

/** The shape of a rejected call. The constructor exists only as `plisto.PlistoError`. */
export interface PlistoError extends Error {
  readonly code: PlistoErrorCode;
  /** Set only for rate_limited: how long to wait before retrying. */
  readonly retryAfterMs: number | null;
  /** Refines the code when the host gives one; "no_gesture" comes with denied. Otherwise null. */
  readonly reason: string | null;
}

export interface PlistoErrorConstructor {
  new (code: PlistoErrorCode, message?: string, retryAfterMs?: number, reason?: string): PlistoError;
  readonly prototype: PlistoError;
}

export interface PlistoEvents {
  visibility: boolean;
  theme: PlistoTheme;
  sidebar: SidebarInput;
  /** The page's route; null for none. */
  route: string | null;
}

export interface Plisto {
  readonly sdkVersion: string;
  /** Resolves with the app info once Plisto has initialised this page. */
  readonly ready: Promise<AppInfo>;
  /** Last known values; null, false and null before init. */
  readonly info: AppInfo | null;
  readonly pageOpen: boolean;
  readonly route: string | null;
  readonly PlistoError: PlistoErrorConstructor;
  call<M extends keyof PlistoMethods>(
    method: M,
    args?: PlistoMethods[M]["args"],
    options?: CallOptions,
  ): Promise<PlistoMethods[M]["result"]>;
  /** For methods this version of the types does not know; rejects unknown_method if the host lacks it. */
  call(method: string, args?: object, options?: CallOptions): Promise<unknown>;
  /** True when the host listed the method at init; false before init. */
  has(method: string): boolean;
  on<E extends keyof PlistoEvents>(event: E, callback: (value: PlistoEvents[E]) => void): () => void;
  readonly app: {
    info(): Promise<AppInfo>;
    methods(): Promise<AppMethodsResult>;
  };
  readonly storage: {
    /** Resolves the stored value when found, else `fallback`. */
    get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<StorageSetResult>;
    remove(key: string): Promise<StorageRemoveResult>;
    keys(prefix?: string): Promise<StorageKeysResult>;
    clear(): Promise<StorageClearResult>;
    usage(): Promise<StorageUsageResult>;
  };
  readonly ui: {
    /** Resolves when the toast leaves the screen. Needs the ui.toast capability. */
    toast(text: string, options?: { action?: string }): Promise<UiToastResult>;
    /** Resolves the user's answer. Needs ui.confirm; refused without a page or a gesture. */
    confirm(args: UiConfirmArgs): Promise<boolean>;
    /** Needs ui.chips. */
    chips(chips: PlistoChipInput[]): Promise<EmptyResult>;
    /** Opens this plugin's own page. Refused without the page open or a gesture. */
    openPage(route?: string | null, gesture?: string): Promise<EmptyResult>;
    readonly sidebar: {
      /** Needs ui.sidebar. */
      update(itemId: string, state: SidebarStateInput): Promise<EmptyResult>;
    };
  };
  /** Needs library.read. */
  readonly library: {
    tracks(options?: LibraryTracksArgs): Promise<PlistoPage<PlistoTrack>>;
    /** Resolves the tracks found, in the order asked. */
    tracksById(ids: number[]): Promise<PlistoTrack[]>;
    albums(options?: LibraryAlbumsArgs): Promise<PlistoPage<PlistoAlbum>>;
    album(id: number): Promise<PlistoAlbum>;
    albumTracks(id: number, options?: PageArgs<"position">): Promise<PlistoPage<PlistoTrack>>;
    playlists(options?: LibraryPlaylistsArgs): Promise<PlistoPage<PlistoPlaylist>>;
    playlist(id: number): Promise<PlistoPlaylist>;
    playlistTracks(id: number, options?: PageArgs<"position">): Promise<PlistoPage<PlistoTrack>>;
    /** Resolves a data: URL, or null when there is no cover. `size` defaults to "thumb". */
    cover(kind: LibraryCoverArgs["kind"], id: number, size?: LibraryCoverArgs["size"]): Promise<string | null>;
  };
  /** `state` and `queue` need playback.read; the rest need playback.control. */
  readonly playback: {
    state(): Promise<PlaybackState>;
    queue(): Promise<PlaybackQueueResult>;
    toggle(): Promise<EmptyResult>;
    pause(): Promise<EmptyResult>;
    resume(): Promise<EmptyResult>;
    next(): Promise<EmptyResult>;
    prev(): Promise<EmptyResult>;
    seek(secs: number): Promise<EmptyResult>;
  };
  /** Needs playback.control. */
  readonly queue: {
    play(source: QueueSource, start?: number): Promise<QueueResult>;
    add(source: QueueSource): Promise<QueueResult>;
    playNext(source: QueueSource): Promise<QueueResult>;
  };
  readonly log: {
    debug(text: string): Promise<LogWriteResult>;
    info(text: string): Promise<LogWriteResult>;
    warn(text: string): Promise<LogWriteResult>;
    error(text: string): Promise<LogWriteResult>;
  };
}

declare global {
  interface Window {
    plisto: Plisto;
  }
}
