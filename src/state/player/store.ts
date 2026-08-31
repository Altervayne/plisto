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
  getPlayerStatus,
  playerNext,
  playerPause,
  playerPlayTracks,
  playerPrev,
  playerResume,
  playerSeek,
  playerSetRepeat,
  playerSetVolume,
  playerStop,
  playerToggle,
} from "../../lib/ipc";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../preferences/store";

// -- Type Imports --
import type { PlayerStatus, RepeatMode } from "../../types";

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
  output_device: null,
};

/** The transport actions, poking the engine and letting its event drive `status` back. */
interface PlayerActions {
  play: (trackIds: number[], index?: number) => void;
  toggle: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  seek: (secs: number) => void;
  setVolume: (v: number) => void;
  setRepeat: (mode: RepeatMode) => void;
}

interface PlayerStore {
  status: PlayerStatus;
  // The last `player:error` string, or null. Held for a surface to read; unused for the MVP.
  error: string | null;
  setStatus: (status: PlayerStatus) => void;
  setError: (error: string | null) => void;
  // One stable object, built once in the initializer, so a card selecting it never re-renders on a
  // status tick. See the perf boundary above.
  actions: PlayerActions;
}

export const usePlayerStore = create<PlayerStore>((set) => ({
  status: STOPPED,
  error: null,
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  actions: {
    // Fire and forget: the engine's event updates `status`, so nothing here mutates it optimistically.
    play: (trackIds, index = 0) => void playerPlayTracks(trackIds, index).catch(() => {}),
    toggle: () => void playerToggle().catch(() => {}),
    pause: () => void playerPause().catch(() => {}),
    resume: () => void playerResume().catch(() => {}),
    stop: () => void playerStop().catch(() => {}),
    next: () => void playerNext().catch(() => {}),
    prev: () => void playerPrev().catch(() => {}),
    seek: (secs) => void playerSeek(secs).catch(() => {}),
    setVolume: (v) => void playerSetVolume(v).catch(() => {}),
    setRepeat: (mode) => void playerSetRepeat(mode).catch(() => {}),
  },
}));

// -- Selectors (narrow: each returns one primitive or the stable actions object) --

export const usePlayerStatus = (): PlayerStatus => usePlayerStore((s) => s.status);
export const useCurrentTrackId = (): number | null =>
  usePlayerStore((s) => s.status.track_id);
export const useIsPlaying = (): boolean => usePlayerStore((s) => s.status.playing);
export const usePlayerActions = (): PlayerActions => usePlayerStore((s) => s.actions);

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
  const setError = usePlayerStore((s) => s.setError);

  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    void getPlayerStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});

    const subscribe = async () => {
      unlisteners.push(
        await listen<PlayerStatus>("player:status", (e) => setStatus(e.payload)),
      );
      unlisteners.push(await listen<string>("player:error", (e) => setError(e.payload)));
    };
    void subscribe().catch(() => {});

    return () => {
      alive = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [setStatus, setError]);
}
