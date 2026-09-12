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
import { useEffect } from "react";

// -- Library Imports --
import { create } from "zustand";
import type { StoreApi } from "zustand";
import { listen } from "@tauri-apps/api/event";

// -- IPC Imports --
import {
  getPlayerQueue,
  getPlayerStatus,
  getTrackDisplay,
  playerEnqueue,
  playerJump,
  playerMoveQueueItem,
  playerNext,
  playerPause,
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
import { snapshotQueueMeta } from "./queueMeta";
import { added } from "./queueToast";

// -- Type Imports --
import type { PlaybackSource, PlayerNotice, PlayerStatus, RepeatMode } from "../../types";
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
};

/** The transport actions, poking the engine and letting its event drive `status` back. */
interface PlayerActions {
  play: (trackIds: number[], index: number, source: PlaybackSource) => void;
  toggle: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  jump: (index: number) => void;
  // Appends tracks to the queue, or starts a fresh play from `source` when nothing is loaded.
  addToQueue: (trackIds: number[], source: PlaybackSource) => void;
  // Moves an up-next row, optimistically reordering the local queue ahead of the engine echo.
  reorderQueue: (from: number, to: number) => void;
  // Drops an up-next row, optimistically shrinking the local queue ahead of the engine echo.
  removeFromQueue: (index: number) => void;
  seek: (secs: number) => void;
  setVolume: (v: number) => void;
  setRepeat: (mode: RepeatMode) => void;
  setShuffle: (on: boolean) => void;
}

/** Returns `list` with the item at `from` moved to `to`, leaving the input untouched. */
function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

interface PlayerStore {
  status: PlayerStatus;
  // Bumped on each `plays:changed` event. The play-history reads depend on it, so a recorded play
  // refetches them without a remount. The event fires after the DB insert, so the new row is present.
  playsVersion: number;
  // The engine's queue ids in play order, shuffle reflected. Its own slice so the status-tick subtree
  // never pulls it; changes only on a play or shuffle toggle.
  queue: number[];
  // The display snapshot for the queue's tracks, captured at play-time so the up-next view renders after
  // the launching view is gone. Keyed by track id.
  queueMeta: Record<number, QueueTrackMeta>;
  // Where the current queue was launched from, for the "playing from" line. Null before the first play.
  playingFrom: PlaybackSource | null;
  // The last player notice, or null. The error toast maps it to a localized line, then clears it.
  error: PlayerNotice | null;
  setStatus: (status: PlayerStatus) => void;
  setQueue: (queue: number[]) => void;
  setError: (error: PlayerNotice | null) => void;
  bumpPlaysVersion: () => void;
  // One stable object, so a card selecting it never re-renders on a status tick. See the perf boundary above.
  actions: PlayerActions;
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
  queueMeta: {},
  playingFrom: null,
  error: null,
  setStatus: (status) => set({ status }),
  // Set the queue, then fill any ad-hoc row's display the play-time snapshot could not reach.
  setQueue: (queue) => {
    set({ queue });
    fillAdHocQueueMeta(get, set, queue);
  },
  setError: (error) => set({ error }),
  bumpPlaysVersion: () => set((s) => ({ playsVersion: s.playsVersion + 1 })),
  actions: {
    // Play records the frontend-only bits the engine cannot know: the source and a metadata snapshot of
    // the queued rows, resolved from the library cache.
    play: (trackIds, index, source) => {
      set({
        playingFrom: source,
        queueMeta: snapshotQueueMeta(trackIds, useAppStore.getState().tracks),
      });
      void playerPlayTracks(trackIds, index).catch(() => {});
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
    addToQueue: (trackIds, source) => {
      const meta = snapshotQueueMeta(trackIds, useAppStore.getState().tracks);
      set((s) => ({ queueMeta: { ...s.queueMeta, ...meta } }));
      if (get().status.track_id == null) {
        get().actions.play(trackIds, 0, source);
      } else {
        void playerEnqueue(trackIds).catch(() => {});
        // The append is silent otherwise; a cold start shows the mini-player instead, its own feedback.
        added(trackIds.length);
      }
    },
    // Reorder locally first so the drop does not snap back for a frame; the `player:queue` echo
    // reconciles to the engine's authoritative order.
    reorderQueue: (from, to) => {
      set((s) => ({ queue: arrayMove(s.queue, from, to) }));
      void playerMoveQueueItem(from, to).catch(() => {});
    },
    // Remove locally first for the same reason; the echo reconciles. queueMeta keeps the stale entry
    // harmlessly.
    removeFromQueue: (index) => {
      set((s) => ({ queue: s.queue.filter((_, i) => i !== index) }));
      void playerRemoveQueueItem(index).catch(() => {});
    },
    seek: (secs) => void playerSeek(secs).catch(() => {}),
    setVolume: (v) => void playerSetVolume(v).catch(() => {}),
    setRepeat: (mode) => void playerSetRepeat(mode).catch(() => {}),
    setShuffle: (on) => void playerSetShuffle(on).catch(() => {}),
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

// The last playback error and its setter, for the toast. The setter is a stable reference, so reading it
// never re-renders on a status tick.
export const usePlayerError = (): PlayerNotice | null => usePlayerStore((s) => s.error);
export const useSetPlayerError = (): ((error: PlayerNotice | null) => void) =>
  usePlayerStore((s) => s.setError);

// The queue slices sit apart from `status` so the up-next list never re-renders on a position tick, and
// the ticking transport never pulls the queue.
export const usePlayerQueue = (): number[] => usePlayerStore((s) => s.queue);
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
 * Wires the store to the engine for the app's life: seeds the snapshot once, then follows the
 * `player:status`, `player:queue`, and `player:error` events. Mount once high in the tree.
 */
export function usePlayerSync(): void {
  const setStatus = usePlayerStore((s) => s.setStatus);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const setError = usePlayerStore((s) => s.setError);
  const bumpPlaysVersion = usePlayerStore((s) => s.bumpPlaysVersion);

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    // Pull the current snapshot and queue, on mount and on each return to visible: a satellite window is
    // created hidden and can miss events fired while hidden, so it re-seeds when shown.
    const seed = () => {
      void getPlayerStatus()
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch(() => {});
      void getPlayerQueue()
        .then((ids) => {
          if (alive) setQueue(ids);
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
      unlisteners.push(await listen<number[]>("player:queue", (e) => setQueue(e.payload)));
      unlisteners.push(await listen<PlayerNotice>("player:error", (e) => setError(e.payload)));
      unlisteners.push(await listen("plays:changed", () => bumpPlaysVersion()));
    };
    void subscribe().catch(() => {});

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      unlisteners.forEach((fn) => fn());
    };
  }, [setStatus, setQueue, setError, bumpPlaysVersion]);
}
