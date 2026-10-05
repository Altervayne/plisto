/*
 * The possible-duplicates store: the dismissed pairs read from the backend, and the groups derived from
 * them over the live tracks. Detection is memoized on the two inputs at module level, so the sheet, the
 * All Tracks filter count and the scan summary share one pass per change.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { useAppStore } from "../store";
import { usePlaylistsStore } from "../playlists/store";
import { usePlayerStore } from "../player/store";

// -- Engine Imports --
import { findDuplicates } from "./findDuplicates";

// -- IPC Imports --
import { listDuplicateDismissals } from "../../lib/ipc";

// -- Type Imports --
import type { DuplicateResult } from "./findDuplicates";
import type { DismissedPair, TrackRow } from "../../types";

interface DuplicatesStore {
  // Null until the first read lands.
  dismissals: DismissedPair[] | null;
  loadDismissals: () => Promise<void>;
}

export const useDuplicatesStore = create<DuplicatesStore>((set, get) => ({
  dismissals: null,

  loadDismissals: async () => {
    try {
      set({ dismissals: await listDuplicateDismissals() });
    } catch {
      // A failed first read falls back to no dismissals so the sheet still opens; a later failure keeps
      // the pairs already held.
      if (get().dismissals == null) set({ dismissals: [] });
    }
  },
}));

// Set once a count surface asked for the first read, so several mounting at once read only once.
let firstReadAsked = false;

const EMPTY: DuplicateResult = { groups: [], dismissed: [] };

let memo: { tracks: TrackRow[]; dismissals: DismissedPair[]; result: DuplicateResult } | null = null;

function duplicatesFor(tracks: TrackRow[], dismissals: DismissedPair[]): DuplicateResult {
  if (memo == null || memo.tracks !== tracks || memo.dismissals !== dismissals) {
    memo = { tracks, dismissals, result: findDuplicates(tracks, dismissals) };
  }
  return memo.result;
}

/**
 * Reloads what a merge or its undo moved outside the organize projection: the playlist slots, the play
 * counts and the dismissed pairs.
 */
export async function refreshAfterMerge(): Promise<void> {
  usePlayerStore.getState().bumpPlaysVersion();
  await Promise.all([
    usePlaylistsStore.getState().load(),
    useDuplicatesStore.getState().loadDismissals(),
  ]);
}

// -- Selectors --

/** The groups over the live tracks, empty until the dismissals are first read. */
export const useDuplicates = (): DuplicateResult => {
  const tracks = useAppStore((s) => s.tracks);
  const dismissals = useDuplicatesStore((s) => s.dismissals);
  return dismissals == null ? EMPTY : duplicatesFor(tracks, dismissals);
};

export const useDismissalsLoaded = (): boolean => useDuplicatesStore((s) => s.dismissals != null);
export const useLoadDismissals = () => useDuplicatesStore((s) => s.loadDismissals);

/**
 * The shown group count and file count, for the entry points. Reads the dismissals once when nothing
 * has read them yet, so a count shows before the sheet ever opens.
 */
export function useDuplicateCounts(): { sets: number; files: number } {
  const loaded = useDismissalsLoaded();
  const loadDismissals = useLoadDismissals();
  useEffect(() => {
    if (!loaded && !firstReadAsked) {
      firstReadAsked = true;
      void loadDismissals();
    }
  }, [loaded, loadDismissals]);
  const { groups } = useDuplicates();
  return {
    sets: groups.length,
    files: groups.reduce((sum, g) => sum + g.trackIds.length, 0),
  };
}
