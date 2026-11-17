/*
 * The player store: the live PlayerStatus snapshot plus the transport actions that poke the native
 * engine. The engine owns playback truth; actions fire and forget, and the `player:status` event
 * drives `status` back, so the UI never guesses.
 *
 * Perf boundary: `status` ticks several times a second, so only the player subtree may read it. The
 * grid and cards read the stable `actions` object alone, which never changes, so they never re-render
 * on a tick. A card must never subscribe to `status`.
 */

// -- Framework Imports --
import { useEffect, useMemo } from "react";

// -- Library Imports --
import { create } from "zustand";
import type { StoreApi } from "zustand";
import { listen } from "@tauri-apps/api/event";

// -- IPC Imports --
import {
  getPlayerQueueState,
  getPlayerStatus,
  getStreamNow,
  getTrackDisplay,
  playerClearParked,
  playerEnqueue,
  playerJump,
  playerMoveQueueItem,
  playerNext,
  playerPause,
  playerPlayNext,
  playerPlayTracks,
  playerPrev,
  playerRemoveQueueItem,
  playerResume,
  playerSeek,
  playerSetRepeat,
  playerSetShuffle,
  playerSetVolume,
  playerStop,
  playerToggle,
} from "../../lib/ipc";

// -- State Imports --
import { useAppStore } from "../store";
import { PREF_KEYS, usePreference, useSetPreference } from "../preferences/store";

// -- Local Imports --
import { blockAt, moveInQueue, removeFromQueueView, spansOfRows } from "./queueBlocks";
import type { QueueRows } from "./queueBlocks";
import { createSeedGuard } from "./seedGuard";
import { snapshotQueueMeta } from "./queueMeta";
import { added, playsAfter } from "./queueToast";
import { nextStreamEnd } from "./streamEnd";
import { resolveStream } from "./streamView";

// -- Type Imports --
import type {
  PlaybackSource,
  PlayerNotice,
  PlayerStatus,
  QueueBlock,
  QueueState,
  RepeatMode,
  StreamEndNotice,
  StreamNow,
} from "../../types";
import type { QueueTrackMeta } from "./queueMeta";

/** The stopped default, held before the first play and after a stop. */
const STOPPED: PlayerStatus = {
  playing: false,
  track_id: null,
  position_secs: 0,
  duration_secs: 0,
  volume: 1,
  repeat: "off",
  queue_index: 0,
  queue_len: 0,
  shuffle: false,
  output_device: null,
  output_taken_over: false,
  stream: null,
  start_seq: 0,
  seek_seq: 0,
};

/** Whether two number lists hold the same values in order. */
function sameList(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** What `playNext` tells its caller about where the tracks went. */
export interface PlayNextOutcome {
  // True when the playing row sits inside a kept block, so the engine placed the tracks after the block.
  afterBlock: boolean;
}

/**
 * The transport actions, poking the engine and letting its event drive `status` back. `blocks` on a play
 * or an append are `[start, length]` spans over `trackIds` whose tracks stay together.
 */
interface PlayerActions {
  play: (
    trackIds: number[],
    index: number,
    source: PlaybackSource,
    blocks?: QueueBlock[],
  ) => void;
  toggle: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  jump: (index: number) => void;
  // Appends tracks to the queue, or starts a fresh play from `source` when nothing is loaded.
  addToQueue: (trackIds: number[], source: PlaybackSource, blocks?: QueueBlock[]) => void;
  // Inserts tracks right after the playing one (after its block when it is inside one), or starts a fresh
  // play from `source` when nothing is loaded.
  playNext: (
    trackIds: number[],
    source: PlaybackSource,
    blocks?: QueueBlock[],
  ) => PlayNextOutcome;
  // Moves an up-next row, optimistically reordering the local queue ahead of the engine echo.
  reorderQueue: (from: number, to: number) => void;
  // Drops an up-next row, optimistically shrinking the local queue ahead of the engine echo.
  removeFromQueue: (index: number) => void;
  seek: (secs: number) => void;
  setVolume: (v: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  setShuffle: (on: boolean) => void;
  // Empties the parked queue while a stream is seated. The stream keeps playing; never a stop.
  clearParked: () => void;
}

export interface PlayerStore {
  status: PlayerStatus;
  // Bumped on each `plays:changed` event. The play-history reads depend on it, so a recorded play
  // refetches them without a remount. The event fires after the DB insert, so the new row is present.
  playsVersion: number;
  // The engine's queue ids in play order, shuffle reflected. Its own slice so the status-tick subtree
  // never pulls it; changes only on a play or shuffle toggle.
  queue: number[];
  // The kept blocks over `queue` as `[start, length]` spans, from the same engine mirror as the ids.
  queueBlocks: QueueBlock[];
  // The hidden row state (tokens, detached flags) of local queue edits, or null once the engine echoes.
  queueRows: QueueRows | null;
  // The display snapshot for the queue's tracks, captured at play-time so the up-next view renders after
  // the launching view is gone. Keyed by track id.
  queueMeta: Record<number, QueueTrackMeta>;
  // Where the current queue was launched from, for the "playing from" line. Null before the first play.
  playingFrom: PlaybackSource | null;
  // The last player notice, or null. The error toast maps it to a localized line, then clears it.
  error: PlayerNotice | null;
  // The seated plugin stream's display state from the hub, or null. Replaced only when the hub emits, so
  // it never changes on a position tick.
  streamNow: StreamNow | null;
  // The last stream end the toast has not shown yet, or null.
  streamEnd: StreamEndNotice | null;
  setStatus: (status: PlayerStatus) => void;
  setQueue: (queue: number[], blocks?: QueueBlock[]) => void;
  setError: (error: PlayerNotice | null) => void;
  setStreamNow: (now: StreamNow | null) => void;
  setStreamEnd: (end: StreamEndNotice | null) => void;
  bumpPlaysVersion: () => void;
  // One stable object, so a card selecting it never re-renders on a status tick. See the perf boundary above.
  actions: PlayerActions;
}

/** The title of the parked track while a stream is seated, or null with no stream or no known title. */
function parkedTrackTitle(s: PlayerStore): string | null {
  const parked = s.status.stream?.parked;
  if (!parked) return null;
  return s.queueMeta[parked.track_id]?.title || null;
}

/**
 * Fills the display snapshot for the queue's ad-hoc rows - negative ids the play-time library snapshot
 * cannot cover. Resolves each missing negative id over IPC (get_track_display is sentinel-aware and
 * returns the stash's title and artist); duration stays null for a stashed file. A late reply is dropped
 * once the queue has moved past its id or the row was filled meanwhile.
 */
function fillAdHocQueueMeta(
  get: StoreApi<PlayerStore>["getState"],
  set: StoreApi<PlayerStore>["setState"],
  queue: number[],
): void {
  const have = get().queueMeta;
  const missing = [...new Set(queue.filter((id) => id < 0 && !(id in have)))];
  if (missing.length === 0) return;

  void Promise.all(
    missing.map((id) =>
      getTrackDisplay(id)
        .then((d) => [id, d] as const)
        .catch(() => null),
    ),
  ).then((results) => {
    const live = new Set(get().queue);
    const merge: Record<number, QueueTrackMeta> = {};
    for (const entry of results) {
      if (!entry) continue;
      const [id, d] = entry;
      if (!live.has(id) || id in get().queueMeta) continue;
      merge[id] = { title: d.title ?? "", artist: d.artist ?? null, durationSecs: null };
    }
    if (Object.keys(merge).length > 0) {
      set((s) => ({ queueMeta: { ...s.queueMeta, ...merge } }));
    }
  });
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  status: STOPPED,
  playsVersion: 0,
  queue: [],
  queueBlocks: [],
  queueRows: null,
  queueMeta: {},
  playingFrom: null,
  error: null,
  streamNow: null,
  streamEnd: null,
  setStatus: (status) => set({ status }),
  // Set the queue, then fill any ad-hoc row's display the play-time snapshot could not reach. A queue
  // of opened files only was launched from no library source, so the source is dropped with it.
  // The hidden row state of local edits survives only an echo that agrees with it.
  setQueue: (queue, blocks = []) => {
    const openedFiles = queue.length > 0 && queue.every((id) => id < 0);
    const held = get().queueRows;
    const agrees =
      held != null &&
      sameList(get().queue, queue) &&
      sameList(spansOfRows(held).flat(), blocks.flat());
    set({
      queue,
      queueBlocks: blocks,
      queueRows: agrees ? held : null,
      ...(openedFiles ? { playingFrom: null } : {}),
    });
    fillAdHocQueueMeta(get, set, queue);
  },
  setError: (error) => set({ error }),
  setStreamNow: (streamNow) => set({ streamNow }),
  setStreamEnd: (incoming) => set((s) => ({ streamEnd: nextStreamEnd(s.streamEnd, incoming) })),
  bumpPlaysVersion: () => set((s) => ({ playsVersion: s.playsVersion + 1 })),
  actions: {
    // Play records the frontend-only bits the engine cannot know: the source and a metadata snapshot of
    // the queued rows, resolved from the library cache.
    play: (trackIds, index, source, blocks) => {
      set({
        playingFrom: source,
        queueMeta: snapshotQueueMeta(trackIds, useAppStore.getState().tracks),
      });
      void playerPlayTracks(trackIds, index, blocks).catch(() => {});
    },
    toggle: () => void playerToggle().catch(() => {}),
    pause: () => void playerPause().catch(() => {}),
    resume: () => void playerResume().catch(() => {}),
    stop: () => void playerStop().catch(() => {}),
    next: () => void playerNext().catch(() => {}),
    prev: () => void playerPrev().catch(() => {}),
    jump: (index) => void playerJump(index).catch(() => {}),
    // Merge the appended rows' metadata so up-next has it, then start a fresh play when nothing is loaded
    // or append otherwise.
    addToQueue: (trackIds, source, blocks) => {
      const meta = snapshotQueueMeta(trackIds, useAppStore.getState().tracks);
      set((s) => ({ queueMeta: { ...s.queueMeta, ...meta } }));
      if (get().status.track_id == null) {
        get().actions.play(trackIds, 0, source, blocks);
      } else {
        void playerEnqueue(trackIds, blocks).catch(() => {});
        // The append is silent otherwise; a cold start shows the mini-player instead, its own feedback.
        added(trackIds.length);
      }
    },
    playNext: (trackIds, source, blocks) => {
      const meta = snapshotQueueMeta(trackIds, useAppStore.getState().tracks);
      set((s) => ({ queueMeta: { ...s.queueMeta, ...meta } }));
      if (get().status.track_id == null) {
        get().actions.play(trackIds, 0, source, blocks);
        return { afterBlock: false };
      }
      // The engine lands the tracks after the playing row's block, so a playing row inside one is the fact.
      const afterBlock = blockAt(get().queueBlocks, get().status.queue_index) >= 0;
      void playerPlayNext(trackIds, blocks).catch(() => {});
      // With a stream seated nothing starts: say where the tracks sit, when a parked track is named.
      const parkedTitle = parkedTrackTitle(get());
      if (parkedTitle) playsAfter(parkedTitle);
      else added(trackIds.length);
      return { afterBlock };
    },
    // Reorder locally first so the drop does not snap back for a frame; the `player:queue_state` echo
    // reconciles to the engine's authoritative order.
    reorderQueue: (from, to) => {
      set((s) => {
        const next = moveInQueue(
          { ids: s.queue, blocks: s.queueBlocks, rows: s.queueRows ?? undefined },
          from,
          to,
        );
        return { queue: next.ids, queueBlocks: next.blocks, queueRows: next.rows ?? null };
      });
      void playerMoveQueueItem(from, to).catch(() => {});
    },
    // Remove locally first for the same reason; the echo reconciles. queueMeta keeps the stale entry
    // harmlessly.
    removeFromQueue: (index) => {
      set((s) => {
        const next = removeFromQueueView(
          { ids: s.queue, blocks: s.queueBlocks, rows: s.queueRows ?? undefined },
          index,
        );
        return { queue: next.ids, queueBlocks: next.blocks, queueRows: next.rows ?? null };
      });
      void playerRemoveQueueItem(index).catch(() => {});
    },
    seek: (secs) => void playerSeek(secs).catch(() => {}),
    setVolume: (v) => void playerSetVolume(v).catch(() => {}),
    setRepeat: (mode) => void playerSetRepeat(mode).catch(() => {}),
    setShuffle: (on) => void playerSetShuffle(on).catch(() => {}),
    clearParked: () => void playerClearParked().catch(() => {}),
  },
}));

// -- Selectors (narrow: each returns one primitive or the stable actions object) --

export const usePlayerStatus = (): PlayerStatus => usePlayerStore((s) => s.status);
export const useCurrentTrackId = (): number | null =>
  usePlayerStore((s) => s.status.track_id);
export const useIsPlaying = (): boolean => usePlayerStore((s) => s.status.playing);
export const useCurrentOutputDevice = (): string | null =>
  usePlayerStore((s) => s.status.output_device);
export const usePlayerActions = (): PlayerActions => usePlayerStore((s) => s.actions);

/**
 * The stream selectors as plain functions, so a test can pin that a position tick leaves each result
 * unchanged. `now` is the hub's object, replaced only on a hub emit; `isStream` is a bare boolean off the
 * engine's status; `pluginName` is a bare string; `artRev` is the seated stream's artwork revision (0 with none).
 */
export const streamSelectors = {
  now: (s: PlayerStore): StreamNow | null => s.streamNow,
  isStream: (s: PlayerStore): boolean => s.status.stream != null,
  hasParked: (s: PlayerStore): boolean => s.status.stream?.parked != null,
  pluginName: (s: PlayerStore): string | null =>
    s.status.stream ? (s.streamNow?.plugin_name ?? "") : null,
  artRev: (s: PlayerStore): number => (s.status.stream ? (s.streamNow?.art_rev ?? 0) : 0),
};

export const useStreamNow = (): StreamNow | null => usePlayerStore(streamSelectors.now);
export const useIsStream = (): boolean => usePlayerStore(streamSelectors.isStream);
/** The stream to draw, or null: the hub's state, or a connecting placeholder in the frame before it arrives. */
export const useSeatedStream = (): StreamNow | null => {
  const seated = useIsStream();
  const now = useStreamNow();
  const item = usePlayerStore((s) => s.status.track_id);
  return useMemo(() => resolveStream(seated, now, item), [seated, now, item]);
};
/** Whether the engine holds a parked track under the seated stream. */
export const useHasParked = (): boolean => usePlayerStore(streamSelectors.hasParked);
/** The seated stream's plugin name (empty before the hub's first state), or null with no stream seated. */
export const useStreamPluginName = (): string | null => usePlayerStore(streamSelectors.pluginName);
// The artwork revision feeds the id-keyed cover hooks.
export const useStreamArtRev = (): number => usePlayerStore(streamSelectors.artRev);
export const useStreamEnd = (): StreamEndNotice | null => usePlayerStore((s) => s.streamEnd);
export const useSetStreamEnd = (): ((end: StreamEndNotice | null) => void) =>
  usePlayerStore((s) => s.setStreamEnd);

// The last playback error and its setter, for the toast. The setter is a stable reference, so reading it
// never re-renders on a status tick.
export const usePlayerError = (): PlayerNotice | null => usePlayerStore((s) => s.error);
export const useSetPlayerError = (): ((error: PlayerNotice | null) => void) =>
  usePlayerStore((s) => s.setError);

// The queue slices sit apart from `status` so the up-next list never re-renders on a position tick, and
// the ticking transport never pulls the queue.
export const usePlayerQueue = (): number[] => usePlayerStore((s) => s.queue);
export const usePlayerQueueBlocks = (): QueueBlock[] => usePlayerStore((s) => s.queueBlocks);
export const usePlayerQueueMeta = (): Record<number, QueueTrackMeta> =>
  usePlayerStore((s) => s.queueMeta);
// The play cursor, read as a bare primitive so the up-next list re-renders on a track change, not on a
// position tick.
export const usePlayerQueueIndex = (): number => usePlayerStore((s) => s.status.queue_index);
export const usePlayingFrom = (): PlaybackSource | null =>
  usePlayerStore((s) => s.playingFrom);

// A monotonically rising token, bumped on each recorded play. The play-history reads depend on it to
// refetch, so it changes only on `plays:changed`, never on a status tick.
export const usePlaysVersion = (): number => usePlayerStore((s) => s.playsVersion);

/** The app's working identity. `player` and `both` show the play affordances; `organizer` hides them. */
export type AppMode = "player" | "organizer" | "both";

const APP_MODES: readonly string[] = ["player", "organizer", "both"];

/**
 * The current app mode. Persisted, default `both`. When the pref is absent, fall back to the old
 * player-enabled boolean: a stored "0" lands in `organizer`, anything else in `both`, so a user who
 * had turned the player off keeps its hidden chrome under the new switch.
 */
export const useAppMode = (): AppMode => {
  const stored = usePreference(PREF_KEYS.appMode);
  const legacyEnabled = usePreference(PREF_KEYS.playerEnabled);
  if (stored && APP_MODES.includes(stored)) return stored as AppMode;
  return legacyEnabled === "0" ? "organizer" : "both";
};

/** Sets the app mode. No playback side effect: switching mode never stops a running track. */
export const useSetAppMode = (): ((mode: AppMode) => void) => {
  const setPreference = useSetPreference();
  return (mode) => setPreference(PREF_KEYS.appMode, mode);
};

/**
 * Whether the play affordances show - the row triangles, the cover disc, the menu Play entries. Derived
 * from the app mode: only `organizer` hides them. A soft gate that never touches the engine, so a
 * running track stays audible from the mini even when hidden.
 */
export const usePlayerEnabled = (): boolean => useAppMode() !== "organizer";

/**
 * Whether the organize controls show on the album wall - the pick ring, Select all, the selection bar.
 * Only `player` hides them.
 */
export const useOrganizeEnabled = (): boolean => useAppMode() !== "player";

/**
 * Wires the store to the engine for the app's life: seeds the snapshot once, then follows the
 * `player:status`, `player:queue_state`, `player:error`, `player:stream` and `player:stream_end` events. Mount
 * once high in the tree.
 */
export function usePlayerSync(): void {
  const setStatus = usePlayerStore((s) => s.setStatus);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const setError = usePlayerStore((s) => s.setError);
  const setStreamNow = usePlayerStore((s) => s.setStreamNow);
  const setStreamEnd = usePlayerStore((s) => s.setStreamEnd);
  const bumpPlaysVersion = usePlayerStore((s) => s.bumpPlaysVersion);

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];
    const queueGuard = createSeedGuard();

    // Pull the current snapshot and queue, on mount and on each return to visible: a satellite window is
    // created hidden and can miss events fired while hidden, so it re-seeds when shown.
    const seed = () => {
      void getPlayerStatus()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
      // A queue event that lands before this reply is newer than it: the reply is dropped.
      const current = queueGuard.begin();
      void getPlayerQueueState()
        .then((state) => {
          if (alive && current()) setQueue(state.ids, state.blocks);
        })
        .catch(() => {});
      void getStreamNow()
        .then((now) => {
          if (alive) setStreamNow(now);
        })
        .catch(() => {});
    };
    seed();

    const onVisibility = () => {
      if (document.visibilityState === "visible") seed();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const subscribe = async () => {
      unlisteners.push(
        await listen<PlayerStatus>("player:status", (e) => setStatus(e.payload)),
      );
      unlisteners.push(
        await listen<QueueState>("player:queue_state", (e) => {
          queueGuard.event();
          setQueue(e.payload.ids, e.payload.blocks);
        }),
      );
      unlisteners.push(await listen<PlayerNotice>("player:error", (e) => setError(e.payload)));
      unlisteners.push(await listen("plays:changed", () => bumpPlaysVersion()));
      unlisteners.push(
        await listen<StreamNow | null>("player:stream", (e) => setStreamNow(e.payload)),
      );
      unlisteners.push(
        await listen<StreamEndNotice>("player:stream_end", (e) => setStreamEnd(e.payload)),
      );
    };
    void subscribe().catch(() => {});

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      unlisteners.forEach((fn) => fn());
    };
  }, [setStatus, setQueue, setError, setStreamNow, setStreamEnd, bumpPlaysVersion]);
}
