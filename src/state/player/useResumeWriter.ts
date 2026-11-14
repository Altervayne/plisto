/*
 * Persists the resume blob as playback moves. A track change, a pause, or a change of the parked track
 * or its cleared flag while a stream is seated writes at once; otherwise a write follows at most every
 * WRITE_DELAY_MS, so a playing position is never far behind. A stop or a queue end writes nothing and
 * never clears the blob, an ad-hoc track never writes, and a stream is never saved: the parked slot is.
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
import { buildResumeBlob } from "./resume";

const WRITE_DELAY_MS = 2000;

/** Mount once in the main window's shell. The tray and widget windows never call it. */
export function useResumeWriter(): void {
  useEffect(() => startResumeWriter(), []);
}

/** Subscribes the writer to the player store and returns its teardown. Split out of the hook so it runs without a DOM. */
export function startResumeWriter(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWritten = "";

  const write = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const { status, queue } = usePlayerStore.getState();
    const blob = buildResumeBlob(status, queue);
    if (!blob) return;
    const json = JSON.stringify(blob);
    if (json === lastWritten) return;
    lastWritten = json;
    void setSetting(PREF_KEYS.playerResume, json).catch(() => {});
  };

  const unsubscribe = usePlayerStore.subscribe((state, prev) => {
    const now = state.status;
    const was = prev.status;
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
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
