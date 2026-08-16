/*
 * The covers workspace store: the loose-image inventory found by the discovery sweep, held apart from
 * the album/track projections. Groups stream in one folder at a time and accumulate here, so the nav
 * badge and the triage view read one shared source. Discovery is a full disk walk that the backend
 * rejects while a scan runs, so a rejection lands as a quiet blocked state rather than an error. A run
 * token drops batches from a superseded sweep, and a bind flips its folder's needs-cover state at once
 * rather than re-walking the whole library.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Local Imports --
import { cancelDiscovery, createDiscoveryChannel, discoverLibraryImages } from "../../lib/ipc";
import { foldId } from "../files/folderTree";

// -- Type Imports --
import type { ImageFolderGroup } from "../../types";

/** Where the sweep stands: never run, streaming its first groups, complete, or refused mid-scan. */
export type CoversStatus = "idle" | "reading" | "ready" | "blocked";

interface CoversStore {
  groups: ImageFolderGroup[];
  status: CoversStatus;
  discover: () => Promise<void>;
  cancel: () => Promise<void>;
  markFolderCovered: (folderPath: string) => void;
  reset: () => void;
}

export const useCoversStore = create<CoversStore>((set) => {
  // Superseded sweeps must not paint into the current one. Bumped on every discover and cancel; a batch
  // whose captured token no longer matches is dropped. Module-scoped, outside React, so a callback reads
  // the live value with no stale closure.
  let runToken = 0;
  // The in-flight sweep, so a re-entry waits for the previous one to release the backend's single-run
  // guard before starting a fresh one. Without this, StrictMode's mount/cancel/mount (and a quick
  // leave-and-return) fire a second discover while the first still holds the guard - the backend rejects
  // it with "already running", which is NOT a scan block; it must not surface the paused screen.
  let pending: Promise<void> | null = null;

  return {
    groups: [],
    status: "idle",

    // Starts a fresh sweep: cancels and awaits any in-flight one, clears the prior inventory, streams each
    // folder group in, and lands on ready when the walk completes - or blocked only when a scan genuinely
    // holds the trees (any other error stays quiet-ready, never the paused screen).
    discover: async () => {
      const token = ++runToken;

      // Let any running sweep release the guard before starting, so only one discover is ever in flight.
      const prev = pending;
      if (prev) {
        await cancelDiscovery();
        await prev.catch(() => {});
      }
      if (token !== runToken) return; // a newer discover superseded us while we waited

      set({ status: "reading", groups: [] });

      const channel = createDiscoveryChannel((group) => {
        if (token === runToken) set((s) => ({ groups: [...s.groups, group] }));
      });

      const run = (async () => {
        try {
          await discoverLibraryImages(channel);
          if (token === runToken) set({ status: "ready" });
        } catch (e) {
          // Only a scan holding the same folders is a real block; anything else (a superseded run) is quiet.
          if (token === runToken) set({ status: /scan/i.test(String(e)) ? "blocked" : "ready" });
        }
      })();
      pending = run;
      try {
        await run;
      } finally {
        if (pending === run) pending = null;
      }
    },

    // Stops the running sweep on leaving the workspace. The token bump abandons any in-flight batch; the
    // accumulated groups stay so the nav badge holds until the next visit refreshes them.
    cancel: async () => {
      runToken++;
      await cancelDiscovery();
    },

    // Flips one folder's needs-cover state after a folder-wide bind, keyed case-insensitively to match the
    // real-case walk path against the folded identity. Only that folder's group object changes, so the
    // rest of the wall holds its identity and never re-renders.
    markFolderCovered: (folderPath) => {
      const target = foldId(folderPath);
      set((s) => ({
        groups: s.groups.map((g) =>
          foldId(g.folder_path) === target ? { ...g, needs_cover: false } : g,
        ),
      }));
    },

    reset: () => {
      runToken++;
      set({ groups: [], status: "idle" });
    },
  };
});

// -- Selectors (narrow: each returns one primitive or one stable reference) --

export const useCoverGroups = (): ImageFolderGroup[] => useCoversStore((s) => s.groups);
export const useCoversStatus = (): CoversStatus => useCoversStore((s) => s.status);

/** The actionable backlog: how many discovered folders still resolve to no cover. Drives the nav badge. */
export const useNeedsCoverCount = (): number =>
  useCoversStore((s) => s.groups.reduce((n, g) => (g.needs_cover ? n + 1 : n), 0));

export const useDiscoverCovers = () => useCoversStore((s) => s.discover);
export const useCancelCovers = () => useCoversStore((s) => s.cancel);
export const useMarkFolderCovered = () => useCoversStore((s) => s.markFolderCovered);
