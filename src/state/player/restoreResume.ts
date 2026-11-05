/*
 * The boot restore: reads the saved resume blob and seats it on the engine paused, never playing. It runs
 * once per session from the main window's shell, only after the startup-file probe found no file (an
 * open-with launch never mounts the library shell, so it ignores the blob and leaves it intact).
 */

// -- IPC Imports --
import { getPlayerStatus, getSetting, getTrackDisplay, playerLoad } from "../../lib/ipc";

// -- State Imports --
import { useAppStore } from "../store";
import { PREF_KEYS } from "../preferences/store";
import { usePlayerStore } from "./store";

// -- Local Imports --
import { withRetry } from "../../lib/withRetry";
import { snapshotQueueMeta } from "./queueMeta";
import { normalizeResume } from "./resume";

// A shell remount must not restore a second time over whatever the user has since played.
let attempted = false;

/** Restores the saved session. Best-effort: any failure leaves the player empty, as before. */
export async function restoreResume(): Promise<void> {
  if (attempted) return;
  attempted = true;

  // A rejection is a cold start, not an empty blob: retry, and give up only once every attempt is spent.
  const raw = await withRetry(() => getSetting(PREF_KEYS.playerResume)).catch(() => null);
  const saved = normalizeResume(raw);
  if (!saved) return;

  // Something already plays (the user was faster than the read): leave it alone.
  const status = await withRetry(() => getPlayerStatus()).catch(() => null);
  if (!status || status.track_id != null) return;

  const { actions } = usePlayerStore.getState();
  // Volume and repeat first, so the load emits the status the UI should show.
  actions.setVolume(saved.volume);
  actions.setRepeat(saved.repeat);
  const loaded = await playerLoad(saved.ids, saved.currentId, saved.secs).catch(() => false);
  if (!loaded) return;

  const meta = snapshotQueueMeta(saved.ids, useAppStore.getState().tracks);
  usePlayerStore.setState({ playingFrom: { kind: "tracks" }, queueMeta: meta });

  // Rows the library cache did not hold come back as empty placeholders: fill them from the backend.
  const missing = saved.ids.filter((id) => meta[id].title === "");
  const filled = await Promise.all(
    missing.map((id) => getTrackDisplay(id).then((d) => [id, d] as const).catch(() => null)),
  );
  const merge: typeof meta = {};
  for (const entry of filled) {
    if (!entry) continue;
    const [id, d] = entry;
    merge[id] = { title: d.title ?? "", artist: d.artist ?? null, durationSecs: null };
  }
  if (Object.keys(merge).length > 0) {
    usePlayerStore.setState((s) => ({ queueMeta: { ...s.queueMeta, ...merge } }));
  }
}
