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
  | "unavailable"
  | "network"
  | "aborted"
  | "plugin_error";

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
  /** The plugin stream that plays now, whoever owns it; null when none does. */
  stream: PlaybackStreamInfo | null;
}
export interface PlaybackStreamInfo {
  title: string;
  artist: string | null;
  live: boolean;
  /** True when the calling plugin owns the stream. */
  mine: boolean;
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

/** Why a stream item ended. */
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

/**
 * The fixed word that refines an end reason, or null. `network`: dns, connect, tls, protocol, closed,
 * redirect, proxy, status. `denied`: origin_not_listed, redirect_not_listed, blocked_address, dev_only.
 * `unsupported`: content_type, playlist, format, codec, seek, decoder. `plugin_gone`: update, consent,
 * safe_mode, or null for a disable, an uninstall and a crash-loop auto-disable.
 */
export type StreamEndDetail = string;

export type StreamState = "connecting" | "buffering" | "playing" | "paused" | "reconnecting";

/** The formats a push item may carry. `pcm_s16le` is little-endian 16-bit frames and needs `rate` and `channels`. */
export type StreamPushSpec =
  | { format: "mp3" | "aac_adts" | "ogg" | "flac" }
  | { format: "pcm_s16le"; rate: number; channels: 1 | 2 };

/** Exactly one of `url` (Plisto fetches it) and `push` (the plugin sends the bytes). */
export type StreamSource =
  | {
      /** Absolute `https` URL (or `http` for a developer loopback origin) on a consented origin; needs `network`. */
      url: string;
      /** The network guide's header rules apply. */
      headers?: Record<string, string>;
      /** True asks the server for ICY metadata and reads `StreamTitle` into `now`. Default false. */
      icy?: boolean;
      push?: never;
    }
  | { push: StreamPushSpec; url?: never; headers?: never; icy?: never };

/** Exactly one of `url` (needs `network`, a consented origin) and `data_b64` (at most 524288 bytes decoded). */
export type StreamArtwork = { url: string; data_b64?: never } | { data_b64: string; url?: never };

export interface StreamSkip {
  next?: boolean;
  prev?: boolean;
}

export interface StreamPlayArgs {
  source: StreamSource;
  /**
   * Pull: by default live when the response has no `content-length` or carries an `icy-*` header, else
   * finite. Push: default true; false means the plugin will call `stream.end`.
   */
  live?: boolean;
  /** 1 to 200 characters once cleaned. */
  title: string;
  /** At most 200 characters; empty reads as absent. */
  artist?: string;
  album?: string;
  /** The line playing now. A live item only: refused `invalid_args` when `live` is false. */
  now?: string;
  artwork?: StreamArtwork;
  /** Which of Next and Previous the plugin takes; both default to false. */
  skip?: StreamSkip;
}
export interface StreamPlayResult {
  item: number;
  state: "connecting";
}

/** At least one field. `null` clears an optional one; `title` cannot be cleared. */
export interface StreamUpdateFields {
  title?: string;
  artist?: string | null;
  album?: string | null;
  now?: string | null;
  artwork?: StreamArtwork | null;
  /** `null` turns both skips off. */
  skip?: StreamSkip | null;
}
export type StreamUpdateArgs = StreamUpdateFields & { item: number };

export interface StreamItemArgs {
  item: number;
}
export interface StreamPushArgs {
  item: number;
  /** Base64 of 1 to 65536 bytes. */
  data_b64: string;
}
export interface StreamPushResult {
  /** Decoded audio waiting to play, in milliseconds. */
  buffered_ms: number;
  /** Bytes the ring still takes. */
  room: number;
}
export interface StreamStateResult {
  /** The caller's own current item; null when it has none. */
  item: number | null;
  state: StreamState | null;
  live: boolean | null;
  seekable: boolean | null;
  /** Listened time for a live item, the play head for a finite one. */
  position_secs: number | null;
  /** Always null today; do not wait for it. */
  duration_secs: number | null;
  buffered_ms: number | null;
  /** The caller's previous item's end, kept for 60 seconds. */
  last_end: { reason: StreamEndReason; detail: StreamEndDetail | null } | null;
}

/** What the owner of the playing stream is told, on both its page and its native program. */
export type StreamEvent =
  | { kind: "state"; item: number; state: StreamState }
  /** Only when `skip` accepted that direction. */
  | { kind: "skip"; item: number; direction: "next" | "prev" }
  /** A push item has room again, after a `busy` answer. */
  | { kind: "room"; item: number; room: number }
  | { kind: "ended"; item: number; reason: StreamEndReason; detail: StreamEndDetail | null };

export interface PlistoPushFromOptions {
  /** Call `stream.end` once the stream is read to its end. Default true. */
  end?: boolean;
}
export interface PlistoPushFromResult {
  /** Bytes written. */
  bytes: number;
}

export interface PlistoStream {
  /** Needs `playback.stream`. Starts the stream at once: it pauses and parks the user's music. */
  play(args: StreamPlayArgs): Promise<StreamPlayResult>;
  update(item: number, fields: StreamUpdateFields): Promise<EmptyResult>;
  /** An ArrayBuffer or a typed array of 1 to 65536 bytes. Rejects `busy` when the ring is full. */
  push(item: number, data: ArrayBuffer | ArrayBufferView): Promise<StreamPushResult>;
  /**
   * Writes a stream of Uint8Array chunks into a push item, waiting for room as the host reports it. Calls
   * `stream.end` after the last byte unless `options.end` is false. Rejects `not_found`, and cancels the
   * stream, when the item ends first.
   */
  pushFrom(
    item: number,
    readable: ReadableStream<Uint8Array>,
    options?: PlistoPushFromOptions,
  ): Promise<PlistoPushFromResult>;
  /** Push items only: no more bytes. What is buffered plays out, then the item ends `finished`. */
  end(item: number): Promise<EmptyResult>;
  pause(item: number): Promise<EmptyResult>;
  resume(item: number): Promise<EmptyResult>;
  /** Ends the item `stopped`. */
  stop(item: number): Promise<EmptyResult>;
  state(): Promise<StreamStateResult>;
}

export interface NetFetchArgs {
  /** Absolute `https` URL (or `http` for a developer loopback origin) on a consented origin; at most 8192 bytes. */
  url: string;
  /** Default "GET". */
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  /** Default "follow". */
  redirect?: "follow" | "manual" | "error";
  /** 1000 to 120000; default 30000. Buffered: the whole call. Streamed: until the headers arrive. */
  timeout_ms?: number;
  /** Default false. */
  stream?: boolean;
  /** Streamed only: 5000 to 600000; default 60000. */
  idle_ms?: number;
  /** 1 to 64 visible ASCII characters; `net.abort` with the same key ends the request or stream. */
  abort_key?: string;
}

/** The answer to a buffered `net.fetch`. Header names are lowercase and `set-cookie` is left out of `headers`. */
export interface NetFetchResult {
  status: number;
  url: string;
  redirected: boolean;
  headers: [string, string][];
  set_cookies: string[];
  /** Empty for HEAD, 204 and 304; at most 8 MiB. */
  body: ArrayBuffer;
}

/** The answer to a streamed `net.fetch`: the headers, and the id of the stream (null when there is no body). */
export interface NetStreamOpenResult {
  status: number;
  url: string;
  redirected: boolean;
  headers: [string, string][];
  set_cookies: string[];
  stream: string | null;
}

export interface NetAbortArgs {
  abort_key: string;
}
export interface NetStreamAckArgs {
  stream: string;
  /** Total bytes the page has consumed so far; never decreases, never above what was sent. */
  bytes: number;
}
export interface NetStreamCancelArgs {
  stream: string;
}
export interface NetSocketOpenArgs {
  /** `wss://` on a consented origin, or `ws://` on a developer loopback origin. */
  url: string;
  /** At most 8 tokens. */
  protocols?: string[];
  headers?: Record<string, string>;
  /** 1000 to 30000; default 15000. */
  timeout_ms?: number;
}
export interface NetSocketOpenResult {
  socket: string;
  protocol: string | null;
}
/** Exactly one of `text` and `data_b64`, each at most 64 KiB. */
export interface NetSocketSendArgs {
  socket: string;
  text?: string;
  data_b64?: string;
}
export interface NetSocketCloseArgs {
  socket: string;
  /** 1000 or 3000 to 4999; default 1000. */
  code?: number;
  /** At most 123 bytes. */
  reason?: string;
}

export type NetBody = string | ArrayBuffer | ArrayBufferView | URLSearchParams;

export interface PlistoFetchInit {
  method?: string;
  headers?: HeadersInit;
  /** At most 1 MiB. Not with GET or HEAD. */
  body?: NetBody | null;
  /** Sent as JSON with `content-type: application/json`. Not together with `body`. */
  json?: unknown;
  redirect?: "follow" | "manual" | "error";
  /** 1000 to 120000; default 30000. */
  timeoutMs?: number;
  /** Aborting sends `net.abort`; the call rejects with `aborted`. */
  signal?: AbortSignal;
  /** Resolve at the headers and read the body as it arrives. */
  stream?: boolean;
  /** Streamed only: 5000 to 600000; default 60000. */
  idleMs?: number;
}

/** The result of `plisto.net.fetch`, shaped like a web `Response`. Any HTTP status resolves. */
export interface PlistoResponse {
  readonly status: number;
  /** True for 200 to 299. */
  readonly ok: boolean;
  /** The final URL after redirects. */
  readonly url: string;
  readonly redirected: boolean;
  readonly headers: Headers;
  /** The `set-cookie` values, which `headers` does not carry. */
  readonly setCookies: string[];
  /** Buffered: a stream over the one buffer. Streamed: the live body, read under a 1 MiB window. */
  readonly body: ReadableStream<Uint8Array>;
  readonly bodyUsed: boolean;
  /** The readers read to the end, so on a live stream they never finish. Each works once. */
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  blob(): Promise<Blob>;
}

export interface PlistoEventSourceInit {
  headers?: HeadersInit;
  /** Sent as `last-event-id` on the first connect. */
  lastEventId?: string;
  timeoutMs?: number;
  idleMs?: number;
}

export interface PlistoEventSourceEvent {
  type: string;
  data: string;
  lastEventId: string;
}

/** The `error` event: `error` is the PlistoError behind it, or null for an answer that is not an event stream. */
export interface PlistoEventSourceError {
  type: "error";
  error: PlistoError | null;
}

export interface PlistoEventSource {
  readonly url: string;
  /** 0 connecting, 1 open, 2 closed. */
  readonly readyState: 0 | 1 | 2;
  onopen: ((event: { type: "open" }) => void) | null;
  onmessage: ((event: PlistoEventSourceEvent) => void) | null;
  onerror: ((event: PlistoEventSourceError) => void) | null;
  addEventListener(type: string, callback: (event: any) => void): void;
  removeEventListener(type: string, callback: (event: any) => void): void;
  close(): void;
}

export interface PlistoSocketInit {
  protocols?: string[];
  headers?: HeadersInit;
  /** 1000 to 30000; default 15000. */
  timeoutMs?: number;
}

export interface PlistoSocket {
  readonly id: string;
  /** The subprotocol the server chose, or null. */
  readonly protocol: string | null;
  /** A string goes as a text message, an ArrayBuffer or typed array as a binary one; at most 64 KiB. */
  send(data: string | ArrayBuffer | ArrayBufferView): Promise<EmptyResult>;
  /** `code` 1000 or 3000 to 4999; `reason` at most 123 bytes. */
  close(code?: number, reason?: string): Promise<EmptyResult>;
  /** Messages and the close that arrive before a handler is set are held and delivered when it is. */
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
}

export interface PlistoNet {
  /** Needs `network`. Resolves for any HTTP status; rejects with PlistoError otherwise. */
  fetch(url: string | URL, init?: PlistoFetchInit): Promise<PlistoResponse>;
  /** Server-Sent Events over a streamed fetch. Needs `network`. */
  eventSource(url: string | URL, options?: PlistoEventSourceInit): PlistoEventSource;
  /** Resolves a blob: URL for an image (a data: URL when blob URLs are unavailable). A non-2xx answer or a non-image rejects with a plain Error carrying `status`. */
  imageUrl(url: string | URL, init?: PlistoFetchInit): Promise<string>;
  /** Releases a URL from `imageUrl`; does nothing for a data: URL. */
  revoke(url: string): void;
  /** Opens a socket and resolves it once the handshake is done. Needs `network`. */
  socket(url: string | URL, options?: PlistoSocketInit): Promise<PlistoSocket>;
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
  "net.fetch": { args: NetFetchArgs; result: NetFetchResult | NetStreamOpenResult };
  "net.abort": { args: NetAbortArgs; result: { aborted: number } };
  "net.stream.ack": { args: NetStreamAckArgs; result: EmptyResult };
  "net.stream.cancel": { args: NetStreamCancelArgs; result: EmptyResult };
  "net.socket.open": { args: NetSocketOpenArgs; result: NetSocketOpenResult };
  "net.socket.send": { args: NetSocketSendArgs; result: EmptyResult };
  "net.socket.close": { args: NetSocketCloseArgs; result: EmptyResult };
  "stream.play": { args: StreamPlayArgs; result: StreamPlayResult };
  "stream.update": { args: StreamUpdateArgs; result: EmptyResult };
  "stream.push": { args: StreamPushArgs; result: StreamPushResult };
  "stream.end": { args: StreamItemArgs; result: EmptyResult };
  "stream.pause": { args: StreamItemArgs; result: EmptyResult };
  "stream.resume": { args: StreamItemArgs; result: EmptyResult };
  "stream.stop": { args: StreamItemArgs; result: EmptyResult };
  "stream.state": { args: {}; result: StreamStateResult };
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
  /**
   * Subscribes to the page events a native plugin's program sends with `topic` (1 to 64 characters of
   * a-z, 0-9, "_", "." and "-"; anything else throws TypeError). Returns an unsubscribe function.
   */
  onPluginEvent(topic: string, callback: (data: unknown) => void): () => void;
  /**
   * Subscribes to the events of the stream this plugin owns (the `stream` topic of onPluginEvent). The page
   * that is newest and running hears them. Returns an unsubscribe function.
   */
  onStream(callback: (event: StreamEvent) => void): () => void;
  /** A native plugin's own program. A UI plugin's calls reject unknown_method. */
  readonly plugin: {
    /**
     * Sends `name` to the program as a `call`. Rejects plugin_error when the program answers with an
     * error, timeout after 10 seconds without an answer, unavailable when the program is not running.
     */
    call(name: string, args?: object, options?: CallOptions): Promise<unknown>;
  };
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
  /** Needs playback.stream. */
  readonly stream: PlistoStream;
  /** Needs network. */
  readonly net: PlistoNet;
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
