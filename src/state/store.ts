/*
 * The app store: the one active workspace and the state of its scan. Actions own the IPC
 * orchestration (pick, scan, cancel) so components stay presentational and only read narrow
 * slices. Track rows are not held here; the grid loads them on its own.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Local Imports --
import { cancelScan, createScanChannel, scanWorkspace } from "../lib/ipc";
import { pickFolder } from "../lib/dialog";

// -- Type Imports --
import type { ScanProgress, ScanSummary } from "../types";

/** Where a scan is in its life: never started, running, finished, or failed. */
export type ScanStatus = "idle" | "scanning" | "done" | "error";

interface ScanState {
  status: ScanStatus;
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  error: string | null;
}

interface AppStore {
  workspace: string | null;
  scan: ScanState;
  pickAndScan: () => Promise<void>;
  rescan: () => Promise<void>;
  changeWorkspace: () => Promise<void>;
  cancel: () => Promise<void>;
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
    } catch (e) {
      set((s) => ({ scan: { ...s.scan, status: "error", error: String(e) } }));
    }
  };

  return {
    workspace: null,
    scan: idleScan,

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

    reset: () => set({ workspace: null, scan: idleScan }),
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

export const usePickAndScan = () => useAppStore((s) => s.pickAndScan);
export const useRescan = () => useAppStore((s) => s.rescan);
export const useChangeWorkspace = () => useAppStore((s) => s.changeWorkspace);
export const useCancelScan = () => useAppStore((s) => s.cancel);
