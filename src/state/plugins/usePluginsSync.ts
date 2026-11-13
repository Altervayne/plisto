/*
 * The frontend end of the plugin registry: reads the list and the boot state through the boot retry, then
 * reloads the list whenever the backend says it changed. A rejected read never reads as "no plugins": the
 * status becomes failed and the earlier rows stay. Only the latest reload may apply, so a slow earlier
 * one cannot overwrite a newer answer.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { usePluginsStore } from "./store";

// -- IPC Imports --
import { pluginsBootState, pluginsList } from "../../lib/ipc";

// -- Utils Imports --
import { withRetry } from "../../lib/withRetry";

/** The event the backend emits after any registry change. Its payload is not used. */
export const PLUGINS_CHANGED = "plugins:changed";

/** Starts the sync and returns its teardown. The hook below is the only production caller. */
export function startPluginsSync(): () => void {
  let alive = true;
  let latest = 0;
  let unlisten: (() => void) | null = null;
  const store = () => usePluginsStore.getState();

  const load = async () => {
    const mine = ++latest;
    if (store().status !== "ready") store().setStatus("loading");
    try {
      // The boot state never changes within a run, so it is read only until it has been seen.
      const [rows, boot] = await Promise.all([
        withRetry(pluginsList),
        store().boot ? Promise.resolve(null) : withRetry(pluginsBootState),
      ]);
      if (!alive || mine !== latest) return;
      if (boot) store().applyBoot(boot);
      store().applyRows(rows);
      store().setStatus("ready");
    } catch {
      if (alive && mine === latest) store().setStatus("failed");
    }
  };

  // Listening first, so a change during the first read is not lost. Without Tauri this rejects and the
  // read below fails into the failed status.
  listen(PLUGINS_CHANGED, () => void load())
    .then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    })
    .catch(() => {});
  void load();

  return () => {
    alive = false;
    unlisten?.();
  };
}

/** Keeps the plugins store loaded and live while the calling component is mounted. */
export function usePluginsSync(): void {
  useEffect(() => startPluginsSync(), []);
}
