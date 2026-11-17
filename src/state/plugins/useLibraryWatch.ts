/*
 * Reports library changes to Rust, which gates and delivers them to subscribed plugins as
 * `library_changed`. Every user edit lands in one of three frontend stores, so the stores are the one
 * place to see them. Changes inside a microtask batch into one call; nothing runs until the plugin
 * runtime is ready, and a failed report is dropped (the next change reports again).
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import type { StoreApi } from "zustand";

// -- State Imports --
import { useAppStore } from "../store";
import { useOrganizeStore } from "../organize/store";
import { usePlaylistsStore } from "../playlists/store";
import { pluginRuntimeReady } from "./frameModel";
import { bindLibrarySink, diffLibrary, mergeChanges, sameSnapshot, unbindLibrarySink } from "./libraryWatch";
import { usePluginsBoot } from "./store";

// -- IPC Imports --
import { pluginLibraryChanged } from "../../lib/ipc";

// -- Type Imports --
import type { LibraryChange } from "../../types";
import type { LibrarySnapshot } from "./libraryWatch";

export interface LibraryWatchDeps {
  /** The rows of the three stores right now. */
  read: () => LibrarySnapshot;
  /** Calls the listener after any of the three stores changes; returns the removal. */
  subscribe: (onChange: () => void) => () => void;
  /** Compares two snapshots; injected so a test can count the work. */
  diff: (prev: LibrarySnapshot, next: LibrarySnapshot) => LibraryChange | null;
  /** Sends one merged change to Rust. */
  report: (change: LibraryChange) => Promise<void>;
  /** Runs the function after the current synchronous work. */
  defer: (run: () => void) => void;
}

/** Starts watching from the current rows and returns the teardown. Does nothing until `ready`. */
export function startLibraryWatch(ready: boolean, deps: LibraryWatchDeps): () => void {
  if (!ready) return () => {};
  let alive = true;
  let last = deps.read();
  let pending: LibraryChange | null = null;

  const flush = () => {
    const change = pending;
    pending = null;
    if (!alive || !change) return;
    deps.report(change).catch(() => {
      // Rust may not be serving yet; the next change reports again.
    });
  };

  const push = (change: LibraryChange) => {
    const first = pending == null;
    pending = pending ? mergeChanges(pending, change) : change;
    if (first) deps.defer(flush);
  };

  const off = deps.subscribe(() => {
    const next = deps.read();
    // Most store changes touch none of the watched arrays: no diff work then.
    if (sameSnapshot(last, next)) return;
    const change = deps.diff(last, next);
    last = next;
    if (change) push(change);
  });
  const entry = (change: LibraryChange) => {
    if (alive) push(change);
  };
  bindLibrarySink(entry);

  return () => {
    alive = false;
    off();
    unbindLibrarySink(entry);
  };
}

/** Subscribes to every store at once; the listener runs after any of them changes. */
function subscribeAll(onChange: () => void): () => void {
  const stores: StoreApi<unknown>[] = [useAppStore, useOrganizeStore, usePlaylistsStore];
  const offs = stores.map((store) => store.subscribe(onChange));
  return () => offs.forEach((off) => off());
}

/** The production dependencies: the three stores, the `plugin_library_changed` command and a microtask. */
export function browserLibraryWatchDeps(): LibraryWatchDeps {
  return {
    read: () => {
      const org = useOrganizeStore.getState().org;
      const playlists = usePlaylistsStore.getState();
      return {
        tracks: useAppStore.getState().tracks,
        albums: org.albums,
        membership: org.membership,
        playlists: playlists.playlists,
        slots: playlists.tracks,
        albumEntries: playlists.albumEntries,
      };
    },
    subscribe: subscribeAll,
    diff: diffLibrary,
    report: pluginLibraryChanged,
    defer: queueMicrotask,
  };
}

/** Keeps plugins told about library changes. Mounted once, at the top of the shell. */
export function useLibraryWatch(): void {
  const runtime = pluginRuntimeReady(usePluginsBoot());

  useEffect(() => startLibraryWatch(runtime, browserLibraryWatchDeps()), [runtime]);
}
