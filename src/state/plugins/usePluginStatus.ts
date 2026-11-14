/*
 * Keeps the status store live: reads every status at start through the boot retry, applies each
 * `plugins:status` event, and reads again whenever the runtime gate changes. A read that fails after its
 * retries leaves the store as it was, so an error is never taken for "no plugins". Statuses are cleared
 * once the runtime leaves running, because Rust serves none then.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { usePluginStatusStore } from "./pluginStatus";
import { PLUGINS_RUNTIME } from "./usePluginsSync";

// -- IPC Imports --
import { pluginStatuses } from "../../lib/ipc";

// -- Utils Imports --
import { withRetry } from "../../lib/withRetry";

// -- Type Imports --
import type { PluginBootState, PluginStatus } from "../../types";

/** The event the backend emits for every host-state or reported-status change of a plugin. */
export const PLUGINS_STATUS = "plugins:status";

/** Starts the sync and returns its teardown. The hook below is the only production caller. */
export function startPluginStatusSync(): () => void {
  let alive = true;
  let latest = 0;
  const unlisten: (() => void)[] = [];
  const store = () => usePluginStatusStore.getState();

  const read = async () => {
    const mine = ++latest;
    try {
      const list = await withRetry(pluginStatuses);
      if (alive && mine === latest) store().applyAll(list);
    } catch {
      // Leave what is held: a failed read says nothing about the plugins.
    }
  };

  const track = (fn: () => void) => {
    if (alive) unlisten.push(fn);
    else fn();
  };
  // Listening first, so a change during the first read is not lost.
  listen<PluginStatus>(PLUGINS_STATUS, (event) => store().apply(event.payload))
    .then(track)
    .catch(() => {});
  listen<PluginBootState>(PLUGINS_RUNTIME, (event) => {
    if (event.payload.runtime !== "running") store().clear();
    void read();
  })
    .then(track)
    .catch(() => {});
  void read();

  return () => {
    alive = false;
    unlisten.forEach((fn) => fn());
  };
}

/** Keeps the status store loaded and live while the calling component is mounted. */
export function usePluginStatusSync(): void {
  useEffect(() => startPluginStatusSync(), []);
}
