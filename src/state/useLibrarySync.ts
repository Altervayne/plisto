/*
 * The frontend end of the background library sync: one subscription for the library shell's life that
 * feeds the `library:*` events into the app store. The snapshot is read once after subscribing, since
 * anything sent before the listeners attached is lost. A running export holds the deltas back, heard
 * from the export's own lifecycle events so every export surface is covered at once.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { useAppStore } from "./store";

// -- IPC Imports --
import { getLibrarySyncStatus } from "../lib/ipc";

// -- Type Imports --
import type {
  LibraryDelta,
  LibrarySyncSummary,
  LibrarySyncTick,
  RootWatchState,
} from "../types";

/** Subscribes the app store to the background sync while the calling component is mounted. */
export function useLibrarySync(): void {
  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];
    const store = () => useAppStore.getState();

    const subscribe = async () => {
      const attach = [
        listen<LibrarySyncTick>("library:sync", (e) => store().applySyncTick(e.payload)),
        listen<LibraryDelta>("library:delta", (e) => store().queueDelta(e.payload)),
        listen<LibrarySyncSummary>("library:summary", (e) => store().applySyncSummary(e.payload)),
        listen<RootWatchState[]>("library:roots-state", (e) => store().setRootStates(e.payload)),
        listen("export:started", () => store().holdSync("export")),
        listen("export:finished", () => store().releaseSync("export")),
        listen("export:failed", () => store().releaseSync("export")),
      ];
      for (const pending of attach) {
        const unlisten = await pending;
        // Unmounted while attaching: drop this listener at once rather than leak it.
        if (alive) unlisteners.push(unlisten);
        else unlisten();
      }
      if (!alive) return;
      const status = await getLibrarySyncStatus();
      if (alive) store().seedSync(status);
    };
    void subscribe().catch(() => {});

    return () => {
      alive = false;
      unlisteners.forEach((fn) => fn());
      // Without its listener the export's end would never be heard, so its hold goes with it.
      store().releaseSync("export");
    };
  }, []);
}
