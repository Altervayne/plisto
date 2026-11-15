/*
 * Persists the resume blob as playback moves. A track change, a pause, or a change of the parked track
 * or its cleared flag while a stream is seated writes at once; otherwise a write follows at most every
 * WRITE_DELAY_MS, so a playing position is never far behind. A stop or a queue end writes nothing and
 * never clears the blob, an ad-hoc track never writes, and a stream is never saved: the parked slot is.
 * Only `clearSavedResume` empties the blob, at once, and holds off every other write until a new track plays.
 *
 * It subscribes to the store imperatively: a hook read of `status` would re-render the shell on every
 * position tick.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- IPC Imports --
import { setSetting } from "../../lib/ipc";

// -- State Imports --
import { PREF_KEYS } from "../preferences/store";
import { usePlayerStore } from "./store";

// -- Local Imports --
import { buildResumeBlob, emptyResumeBlob } from "./resume";

const WRITE_DELAY_MS = 2000;

let clearActive: (() => void) | null = null;

/**
 * Empties the saved resume blob now, for a cleared queue with no stream. A pending delayed write is
 * dropped and writes stay held until a new track plays, so a quick quit leaves nothing to restore.
 */
export function clearSavedResume(): void {
  if (clearActive) clearActive();
  else void setSetting(PREF_KEYS.playerResume, JSON.stringify(emptyResumeBlob(usePlayerStore.getState().status))).catch(() => {});
}

/** Mount once in the main window's shell. The tray and widget windows never call it. */
export function useResumeWriter(): void {
  useEffect(() => startResumeWriter(), []);
}

/** Subscribes the writer to the player store and returns its teardown. Split out of the hook so it runs without a DOM. */
export function startResumeWriter(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWritten = "";
  let held = false;

  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (held) return;
    const { status, queue } = usePlayerStore.getState();
    const blob = buildResumeBlob(status, queue);
    if (!blob) return;
    const json = JSON.stringify(blob);
    if (json === lastWritten) return;
    lastWritten = json;
    void setSetting(PREF_KEYS.playerResume, json).catch(() => {});
  };

  clearActive = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    held = true;
    lastWritten = JSON.stringify(emptyResumeBlob(usePlayerStore.getState().status));
    void setSetting(PREF_KEYS.playerResume, lastWritten).catch(() => {});
  };

  const unsubscribe = usePlayerStore.subscribe((state, prev) => {
    const now = state.status;
    const was = prev.status;
    if (held && now.track_id != null && now.track_id !== was.track_id) held = false;
    const parkedChanged =
      now.stream?.parked?.track_id !== was.stream?.parked?.track_id ||
      now.stream?.parked_cleared !== was.stream?.parked_cleared;
    if (now.track_id !== was.track_id || (was.playing && !now.playing) || parkedChanged) {
      write();
    } else if (!timer) {
      timer = setTimeout(write, WRITE_DELAY_MS);
    }
  });

  return () => {
    clearActive = null;
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
