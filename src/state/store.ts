/*
 * The app store: the one active workspace, the state of its scan, and the indexed rows. Actions
 * own the IPC orchestration (pick, scan, cancel, load) so components stay presentational and only
 * read narrow slices. Rows load in one pass after a scan lands; the grid sorts and filters them
 * client-side.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Local Imports --
import { cancelScan, createScanChannel, listTracks, scanWorkspace } from "../lib/ipc";
import { pickFolder } from "../lib/dialog";

// -- Type Imports --
import type { ScanProgress, ScanSummary, TrackRow } from "../types";

/** Where a scan is in its life: never started, running, finished, or failed. */
export type ScanStatus = "idle" | "scanning" | "done" | "error";

/** The grid's sort, structurally the table lib's SortingState but without the coupling. */
export type GridSort = { id: string; desc: boolean }[];

interface ScanState {
  status: ScanStatus;
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  error: string | null;
}

interface AppStore {
  workspace: string | null;
  scan: ScanState;
  tracks: TrackRow[];
  // Grid sort and search live here, not in the grid, so a re-scan (which unmounts the grid)
  // does not lose them.
  gridSort: GridSort;
  gridFilter: string;
  pickAndScan: () => Promise<void>;
  rescan: () => Promise<void>;
  changeWorkspace: () => Promise<void>;
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
  // Runs a scan of `path` and drives the scan state from its progress and outcome. A cancelled
  // run still returns a summary, so it lands in 'done' with the partial index intact.
  const runScan = async (path: string): Promise<void> => {
    set({
      workspace: path,
      scan: { status: "scanning", progress: null, summary: null, error: null },
    });

    const channel = createScanChannel((progress) => {
      // scanned is monotonic on the backend; guard against an out-of-order tick regressing it.
      const prev = get().scan.progress;
      const scanned = prev ? Math.max(prev.scanned, progress.scanned) : progress.scanned;
      set((s) => ({ scan: { ...s.scan, progress: { ...progress, scanned } } }));
    });

    try {
      const summary = await scanWorkspace(path, channel);
      set((s) => ({ scan: { ...s.scan, status: "done", summary } }));
      // A cancelled run still leaves a valid partial index, so load either way.
      await get().loadTracks();
    } catch (e) {
      set((s) => ({ scan: { ...s.scan, status: "error", error: String(e) } }));
    }
  };

  return {
    workspace: null,
    scan: idleScan,
    tracks: [],
    gridSort: [],
    gridFilter: "",

    pickAndScan: async () => {
      const path = await pickFolder();
      if (path) await runScan(path);
    },

    rescan: async () => {
      const path = get().workspace;
      if (path) await runScan(path);
    },

    changeWorkspace: async () => {
      const path = await pickFolder();
      if (path) await runScan(path);
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
      set({ workspace: null, scan: idleScan, tracks: [], gridSort: [], gridFilter: "" }),
  };
});

// -- Selectors (narrow: each returns one primitive or one stable reference) --

export const useWorkspace = (): string | null => useAppStore((s) => s.workspace);
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

if (import.meta.env.DEV) {
  (window as unknown as { __store?: typeof useAppStore }).__store = useAppStore;
}

export const usePickAndScan = () => useAppStore((s) => s.pickAndScan);
export const useRescan = () => useAppStore((s) => s.rescan);
export const useChangeWorkspace = () => useAppStore((s) => s.changeWorkspace);
export const useCancelScan = () => useAppStore((s) => s.cancel);
