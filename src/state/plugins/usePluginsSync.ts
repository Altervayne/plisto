/*
 * The frontend end of the plugin registry: reads the list and the boot view through the boot retry, then
 * reloads the list whenever the backend says it changed and takes the runtime gate from its event. A
 * rejected read never reads as "no plugins" or "developer mode off": the status becomes failed and the
 * earlier rows and switch stay. Only the latest reload may apply, so a slow earlier one cannot overwrite
 * a newer answer, and a read that began before a local row change is discarded and run once more so it
 * cannot undo that change.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { usePluginsStore } from "./store";

// -- Type Imports --
import type { PluginBootState } from "../../types";

// -- IPC Imports --
import { pluginsBootState, pluginsDevMode, pluginsList } from "../../lib/ipc";

// -- Utils Imports --
import { withRetry } from "../../lib/withRetry";

/** The event the backend emits after any registry change. Its payload is not used. */
export const PLUGINS_CHANGED = "plugins:changed";

/** The event the backend emits when the runtime gate changes; its payload is the boot view. */
export const PLUGINS_RUNTIME = "plugins:runtime";

// The running sync's reload, so a flow that found the list stale can read it again.
let activeReload: (() => Promise<boolean>) | null = null;

/** Reads the list again through the running sync. Resolves false when the read failed or no sync is mounted. */
export function reloadPlugins(): Promise<boolean> {
  return activeReload ? activeReload() : Promise.resolve(false);
}

/** Starts the sync and returns its teardown. The hook below is the only production caller. */
export function startPluginsSync(): () => void {
  let alive = true;
  let latest = 0;
  const unlisten: (() => void)[] = [];
  const store = () => usePluginsStore.getState();

  /** Resolves true when the list was read, even if a newer read superseded it. */
  const load = async (rerun = true): Promise<boolean> => {
    const mine = ++latest;
    const epoch = store().epoch;
    if (store().status !== "ready") store().setStatus("loading");
    try {
      // The runtime event keeps the boot view current, so it is read only until one has been seen.
      const [rows, boot, devMode] = await Promise.all([
        withRetry(pluginsList),
        store().boot ? Promise.resolve(null) : withRetry(pluginsBootState),
        withRetry(pluginsDevMode),
      ]);
      if (!alive || mine !== latest) return true;
      if (store().epoch !== epoch && rerun) return load(false);
      // A runtime event that landed during the read is newer than the read.
      if (boot && !store().boot) store().applyBoot(boot);
      store().applyRows(rows);
      store().applyDevMode(devMode);
      store().setStatus("ready");
      return true;
    } catch {
      if (alive && mine === latest) store().setStatus("failed");
      return false;
    }
  };

  // Listening first, so a change during the first read is not lost. A rejected listen retries; one that
  // keeps rejecting is dropped, and the read below fails into the failed status.
  const track = (fn: () => void) => {
    if (alive) unlisten.push(fn);
    else fn();
  };
  withRetry(() => listen(PLUGINS_CHANGED, () => void load()))
    .then(track)
    .catch(() => {});
  withRetry(() => listen<PluginBootState>(PLUGINS_RUNTIME, (event) => store().applyBoot(event.payload)))
    .then(track)
    .catch(() => {});
  void load();
  activeReload = load;

  return () => {
    alive = false;
    if (activeReload === load) activeReload = null;
    unlisten.forEach((fn) => fn());
  };
}

/** Keeps the plugins store loaded and live while the calling component is mounted. */
export function usePluginsSync(): void {
  useEffect(() => startPluginsSync(), []);
}
