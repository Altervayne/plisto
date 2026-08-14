/*
 * The app store: the library of roots, the state of a scan, and the indexed rows. Actions own the
 * IPC orchestration (boot, add/remove/rescan a root, cancel, load) so components stay presentational
 * and only read narrow slices. The app boots by hydrating the roots and, when any exist, the rows;
 * every scanning action shares one channel/progress/done/error runner. The grid sorts and filters
 * the rows client-side.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Local Imports --
import {
  addRoot as addRootCmd,
  cancelScan,
  createScanChannel,
  listRoots,
  listTracks,
  removeRoot as removeRootCmd,
  rescanAll as rescanAllCmd,
  rescanRoot as rescanRootCmd,
} from "../lib/ipc";
import { pickFolder } from "../lib/dialog";

// -- Type Imports --
import type { Channel } from "@tauri-apps/api/core";
import type { Root, ScanProgress, ScanSummary, TrackRow } from "../types";

/** Where a scan is in its life: never started, running, finished, or failed. */
export type ScanStatus = "idle" | "scanning" | "done" | "error";

/** The grid's sort, structurally the table lib's SortingState but without the coupling. */
export type GridSort = { id: string; desc: boolean }[];

/** The top-bar library label: the sole root's path when there is one, else the folder count. */
export type LibraryLabel =
  | { kind: "single"; path: string }
  | { kind: "many"; count: number };

interface ScanState {
  status: ScanStatus;
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  error: string | null;
}

interface AppStore {
  roots: Root[];
  booted: boolean;
  scan: ScanState;
  tracks: TrackRow[];
  // Grid sort and search live here, not in the grid, so a re-scan (which unmounts the grid)
  // does not lose them.
  gridSort: GridSort;
  gridFilter: string;
  boot: () => Promise<void>;
  loadRoots: () => Promise<void>;
  addRoot: () => Promise<void>;
  removeRoot: (id: number) => Promise<void>;
  rescanRoot: (id: number) => Promise<void>;
  rescanAll: () => Promise<void>;
  cancel: () => Promise<void>;
  loadTracks: () => Promise<void>;
  setGridSort: (sort: GridSort) => void;
  setGridFilter: (filter: string) => void;
  reset: () => void;
}

const idleScan: ScanState = {
  status: "idle",
  progress: null,
  summary: null,
  error: null,
};

export const useAppStore = create<AppStore>((set, get) => {
  // Drives the scan state from a scanning job's progress and outcome, over a fresh channel. A
  // cancelled run still resolves with a summary, so it lands in 'done' with the partial index intact.
  // Returns whether the job succeeded, so the caller reloads only on a landed scan.
  const runScanJob = async (
    job: (channel: Channel<ScanProgress>) => Promise<ScanSummary>,
  ): Promise<boolean> => {
    set({ scan: { status: "scanning", progress: null, summary: null, error: null } });

    const channel = createScanChannel((progress) => {
      // scanned is monotonic on the backend; guard against an out-of-order tick regressing it.
      const prev = get().scan.progress;
      const scanned = prev ? Math.max(prev.scanned, progress.scanned) : progress.scanned;
      set((s) => ({ scan: { ...s.scan, progress: { ...progress, scanned } } }));
    });

    try {
      const summary = await job(channel);
      set((s) => ({ scan: { ...s.scan, status: "done", summary } }));
      return true;
    } catch (e) {
      set((s) => ({ scan: { ...s.scan, status: "error", error: String(e) } }));
      return false;
    }
  };

  return {
    roots: [],
    booted: false,
    scan: idleScan,
    tracks: [],
    gridSort: [],
    gridFilter: "",

    boot: async () => {
      await get().loadRoots();
      // Open into the last index when the library has roots; no auto-rescan on launch.
      if (get().roots.length > 0) await get().loadTracks();
      set({ booted: true });
    },

    loadRoots: async () => {
      try {
        const roots = await listRoots();
        set({ roots });
      } catch {
        set({ roots: [] });
      }
    },

    addRoot: async () => {
      const path = await pickFolder();
      if (!path) return;
      const ok = await runScanJob((channel) => addRootCmd(path, channel));
      if (ok) {
        await get().loadRoots();
        await get().loadTracks();
      }
    },

    removeRoot: async (id) => {
      await removeRootCmd(id);
      await get().loadRoots();
      await get().loadTracks();
    },

    rescanRoot: async (id) => {
      const ok = await runScanJob((channel) => rescanRootCmd(id, channel));
      if (ok) await get().loadTracks();
    },

    rescanAll: async () => {
      const ok = await runScanJob((channel) => rescanAllCmd(channel));
      if (ok) await get().loadTracks();
    },

    cancel: async () => {
      await cancelScan();
    },

    loadTracks: async () => {
      try {
        const { rows } = await listTracks({});
        set({ tracks: rows });
      } catch {
        set({ tracks: [] });
      }
    },

    setGridSort: (gridSort) => set({ gridSort }),
    setGridFilter: (gridFilter) => set({ gridFilter }),

    reset: () =>
      set({
        roots: [],
        booted: false,
        scan: idleScan,
        tracks: [],
        gridSort: [],
        gridFilter: "",
      }),
  };
});

// -- Selectors (narrow: each returns one primitive or one stable reference) --

export const useRoots = (): Root[] => useAppStore((s) => s.roots);
export const useBooted = (): boolean => useAppStore((s) => s.booted);

/**
 * The top-bar library label, composed from the roots: one root reads as its path (the folder name),
 * several as a plain count. Null when the library is empty. Built here, not as a store selector, so
 * the fresh object never destabilizes a subscription.
 */
export const useLibraryLabel = (): LibraryLabel | null => {
  const roots = useRoots();
  if (roots.length === 0) return null;
  if (roots.length === 1) return { kind: "single", path: roots[0].path };
  return { kind: "many", count: roots.length };
};

export const useScanStatus = (): ScanStatus => useAppStore((s) => s.scan.status);
export const useScanProgress = (): ScanProgress | null =>
  useAppStore((s) => s.scan.progress);
export const useScanSummary = (): ScanSummary | null =>
  useAppStore((s) => s.scan.summary);
export const useScanError = (): string | null => useAppStore((s) => s.scan.error);

export const useTracks = (): TrackRow[] => useAppStore((s) => s.tracks);
export const useGridSort = (): GridSort => useAppStore((s) => s.gridSort);
export const useGridFilter = (): string => useAppStore((s) => s.gridFilter);

export const useSetGridSort = () => useAppStore((s) => s.setGridSort);
export const useSetGridFilter = () => useAppStore((s) => s.setGridFilter);

export const useBoot = () => useAppStore((s) => s.boot);
export const useLoadRoots = () => useAppStore((s) => s.loadRoots);
export const useAddRoot = () => useAppStore((s) => s.addRoot);
export const useRemoveRoot = () => useAppStore((s) => s.removeRoot);
export const useRescanRoot = () => useAppStore((s) => s.rescanRoot);
export const useRescanAll = () => useAppStore((s) => s.rescanAll);
export const useCancelScan = () => useAppStore((s) => s.cancel);
