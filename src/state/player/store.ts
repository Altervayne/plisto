/*
 * The player store: the live PlayerStatus snapshot plus the transport actions that poke the native
 * engine. The engine owns playback truth - each action fires and forgets, and the throttled
 * `player:status` event drives `status` back into the store, so the UI never optimistically guesses
 * the engine's state.
 *
 * Perf boundary: the position ticks about five times a second, so only the player subtree may read
 * `status`. The grid and album cards read `actions` alone, which is one object built once and never
 * replaced - selecting it never re-renders on a status tick, so a memoized wall of cards stays still
 * while the playhead moves. Keep it that way: a card must never subscribe to `status`.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

// -- IPC Imports --
import {
  getPlayerQueue,
  getPlayerStatus,
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

// -- Type Imports --
import type { PlaybackSource, PlayerStatus, RepeatMode } from "../../types";
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
  // The engine's ordered queue ids in the active play order, shuffle reflected. Its own slice, read
  // through `usePlayerQueue`, so the status-tick subtree never pulls it; it changes only on a play or a
  // shuffle toggle.
  queue: number[];
  // The display snapshot for the queue's tracks, captured at play-time so the up-next view renders after
  // the launching view is gone. Keyed by track id.
  queueMeta: Record<number, QueueTrackMeta>;
  // Where the current queue was launched from, for the "playing from" line. Null before the first play.
  playingFrom: PlaybackSource | null;
  // The last `player:error` string, or null. Held for a surface to read; unused for the MVP.
  error: string | null;
  setStatus: (status: PlayerStatus) => void;
  setQueue: (queue: number[]) => void;
  setError: (error: string | null) => void;
  // One stable object, built once in the initializer, so a card selecting it never re-renders on a
  // status tick. See the perf boundary above.
  actions: PlayerActions;
}

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  status: STOPPED,
  queue: [],
  queueMeta: {},
  playingFrom: null,
  error: null,
  setStatus: (status) => set({ status }),
  setQueue: (queue) => set({ queue }),
  setError: (error) => set({ error }),
  actions: {
    // Fire and forget: the engine's event updates `status`, so nothing here mutates it optimistically.
    // Play alone records the frontend-only bits the engine cannot know - the source it came from and a
    // metadata snapshot of the queued rows, resolved from the library cache loaded at play-time.
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
    // Merge the appended rows' metadata so up-next never renders "Unknown track", then either start a
    // fresh play (nothing loaded) or append. A cold start routes through play for the right queue and
    // "playing from" source; the enqueue echo folds back through the `player:queue` listener.
    addToQueue: (trackIds, source) => {
      const meta = snapshotQueueMeta(trackIds, useAppStore.getState().tracks);
      set((s) => ({ queueMeta: { ...s.queueMeta, ...meta } }));
      if (get().status.track_id == null) {
        get().actions.play(trackIds, 0, source);
      } else {
        void playerEnqueue(trackIds).catch(() => {});
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

// The queue slices sit apart from `status` so the up-next list never re-renders on a position tick, and
// the ticking transport never pulls the queue.
export const usePlayerQueue = (): number[] => usePlayerStore((s) => s.queue);
export const usePlayerQueueMeta = (): Record<number, QueueTrackMeta> =>
  usePlayerStore((s) => s.queueMeta);
// The play cursor, read as a bare primitive so the up-next list re-renders on a track change, never on a
// position tick - the queue subtree stays off the tick that only moves the playhead.
export const usePlayerQueueIndex = (): number => usePlayerStore((s) => s.status.queue_index);
export const usePlayingFrom = (): PlaybackSource | null =>
  usePlayerStore((s) => s.playingFrom);

/**
 * Whether the scattered play affordances show. Persisted, default on: an absent pref reads on, so the
 * player is live until the user quiets it. This is a soft switch - it only hides the play chrome, it
 * never touches the engine, so music left running stays audible and controllable from the mini.
 */
export const usePlayerEnabled = (): boolean => usePreference(PREF_KEYS.playerEnabled) !== "0";

/**
 * Flips the player-enabled pref. Best-effort persist like every other pref. No playback side effect:
 * quieting the controls must never stop or pause a track that is already playing.
 */
export const useSetPlayerEnabled = (): ((on: boolean) => void) => {
  const setPreference = useSetPreference();
  return (on) => setPreference(PREF_KEYS.playerEnabled, on ? "1" : "0");
};

/**
 * Wires the store to the engine for the app's life: seeds the snapshot once (the engine may already
 * be mid-play), then follows the throttled `player:status` and the `player:error` events. Mount it
 * once high in the tree; both listeners tear down on unmount. Mirrors the tray's event wiring.
 */
export function usePlayerSync(): void {
  const setStatus = usePlayerStore((s) => s.setStatus);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const setError = usePlayerStore((s) => s.setError);

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    // Pull the current snapshot and queue. Runs on mount and again each time this webview becomes
    // visible: a satellite window (tray popup, pop-out widget) is created hidden and can miss the events
    // that fired while it was hidden, so it re-seeds the moment it is shown rather than trusting it
    // caught every event. The main window is always visible, so this only ever fires its mount seed.
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
      unlisteners.push(await listen<string>("player:error", (e) => setError(e.payload)));
    };
    void subscribe().catch(() => {});

    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisibility);
      unlisteners.forEach((fn) => fn());
    };
  }, [setStatus, setQueue, setError]);
}
