/*
 * The app store: the library of roots, the state of a scan, and the indexed rows. Actions own the IPC
 * orchestration so components stay presentational and read narrow slices. Every scanning action shares
 * one channel/progress/done/error runner; the grid sorts and filters the rows client-side.
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
  setTrackEdit as setTrackEditCmd,
  setTrackGenres as setTrackGenresCmd,
} from "../lib/ipc";
import { pickFolder } from "../lib/dialog";
import { withRetry } from "../lib/withRetry";

// -- Type Imports --
import type { GridFacet } from "../components/tracks/trackFacets";

// -- State Imports --
// The organize store depends on this one (runtime only), so this back-reference is a safe cycle: it is
// touched solely inside actions, to mirror a peek edit into the album membership projection.
import { useOrganizeStore } from "./organize/store";

// -- Type Imports --
import type { Channel } from "@tauri-apps/api/core";
import type {
  Root,
  ScanProgress,
  ScanSummary,
  TrackEditFields,
  TrackRow,
} from "../types";

/** Where a scan is in its life: never started, running, finished, or failed. */
export type ScanStatus = "idle" | "scanning" | "done" | "error";

/** The grid's sort, structurally the table lib's SortingState but without the coupling. */
export type GridSort = { id: string; desc: boolean }[];

/** How the flat file list draws: the dense table or the cover wall. */
export type FilesViewMode = "table" | "cards";

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
  // Grid sort, search, facet chips, and the flat-list view mode live here, not in the grid, so a
  // re-scan (which unmounts the grid) does not lose them.
  gridSort: GridSort;
  gridFilter: string;
  gridFacets: GridFacet[];
  filesView: FilesViewMode;
  boot: () => Promise<void>;
  loadRoots: () => Promise<void>;
  addRoot: () => Promise<void>;
  addRootPath: (path: string) => Promise<boolean>;
  removeRoot: (id: number) => Promise<void>;
  rescanRoot: (id: number) => Promise<void>;
  rescanAll: () => Promise<void>;
  cancel: () => Promise<void>;
  loadTracks: () => Promise<void>;
  editTrack: (trackId: number, fields: TrackEditFields) => Promise<void>;
  setTrackGenres: (trackId: number, genreIds: number[]) => Promise<void>;
  setGridSort: (sort: GridSort) => void;
  setGridFilter: (filter: string) => void;
  setGridFacets: (facets: GridFacet[]) => void;
  setFilesView: (view: FilesViewMode) => void;
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
    gridFacets: [],
    filesView: "table",

    boot: async () => {
      await get().loadRoots();
      // Open into the last index when the library has roots; no auto-rescan on launch.
      if (get().roots.length > 0) await get().loadTracks();
      set({ booted: true });
    },

    loadRoots: async () => {
      try {
        // Retried: an early boot read can reject before managed state is ready. An empty result is not
        // a rejection, so a genuinely empty library still resolves at once and shows onboarding.
        const roots = await withRetry(listRoots);
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

    // Indexes an already-known folder as a root, the same ingest addRoot runs once a folder is picked.
    // The splicer hands its finished output folder here to bring the fresh cuts into the library.
    addRootPath: async (path) => {
      const ok = await runScanJob((channel) => addRootCmd(path, channel));
      if (ok) {
        await get().loadRoots();
        await get().loadTracks();
      }
      return ok;
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
        // Retried for the same boot-race reason as loadRoots: it runs right after the roots hydrate.
        const { rows } = await withRetry(() => listTracks({}));
        set({ tracks: rows });
      } catch {
        set({ tracks: [] });
      }
    },

    // The Files-view peek edits tags and genres optimistically: patch the row, fire the write, reload
    // from truth on a failed persist. The album drawer edits the same commands through the organize
    // store, so either surface's next reload reconciles the two views.
    editTrack: async (trackId, fields) => {
      set((s) => ({
        tracks: s.tracks.map((r) =>
          r.id === trackId
            ? {
                ...r,
                title_edit: fields.title,
                artist_edit: fields.artist,
                album_edit: fields.album,
                album_artist_edit: fields.album_artist,
                year_edit: fields.year,
                disc_edit: fields.disc_no,
              }
            : r,
        ),
      }));
      // Mirror the edit into the album membership projection so the folder view's row updates with the peek.
      useOrganizeStore.getState().reprojectTrackFromApp(trackId);
      try {
        await setTrackEditCmd(trackId, fields);
      } catch {
        await get().loadTracks();
      }
    },

    setTrackGenres: async (trackId, genreIds) => {
      set((s) => ({
        tracks: s.tracks.map((r) => (r.id === trackId ? { ...r, genre_ids: genreIds } : r)),
      }));
      useOrganizeStore.getState().reprojectTrackFromApp(trackId);
      try {
        await setTrackGenresCmd(trackId, genreIds);
      } catch {
        await get().loadTracks();
      }
    },

    setGridSort: (gridSort) => set({ gridSort }),
    setGridFilter: (gridFilter) => set({ gridFilter }),
    setGridFacets: (gridFacets) => set({ gridFacets }),
    setFilesView: (filesView) => set({ filesView }),

    reset: () =>
      set({
        roots: [],
        booted: false,
        scan: idleScan,
        tracks: [],
        gridSort: [],
        gridFilter: "",
        gridFacets: [],
        filesView: "table",
      }),
  };
});

// -- Selectors (narrow: each returns one primitive or one stable reference) --

export const useRoots = (): Root[] => useAppStore((s) => s.roots);
export const useBooted = (): boolean => useAppStore((s) => s.booted);

/**
 * The top-bar library label from the roots: one root reads as its path, several as a count, null when
 * empty. Built here, not as a store selector, so the fresh object never destabilizes a subscription.
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

/**
 * The live row for one track id, or undefined when it is gone. Returns the stored row reference
 * itself, so a subscriber re-renders only when that row is patched - the detail peek reads through
 * this to see its own optimistic edits, rather than the stale snapshot held at select time.
 */
export const useTrack = (id: number): TrackRow | undefined =>
  useAppStore((s) => s.tracks.find((r) => r.id === id));

export const useGridSort = (): GridSort => useAppStore((s) => s.gridSort);
export const useGridFilter = (): string => useAppStore((s) => s.gridFilter);
export const useGridFacets = (): GridFacet[] => useAppStore((s) => s.gridFacets);
export const useFilesView = (): FilesViewMode => useAppStore((s) => s.filesView);

export const useSetGridSort = () => useAppStore((s) => s.setGridSort);
export const useSetGridFilter = () => useAppStore((s) => s.setGridFilter);
export const useSetGridFacets = () => useAppStore((s) => s.setGridFacets);
export const useSetFilesView = () => useAppStore((s) => s.setFilesView);

export const useBoot = () => useAppStore((s) => s.boot);
export const useLoadRoots = () => useAppStore((s) => s.loadRoots);
export const useAddRoot = () => useAppStore((s) => s.addRoot);
export const useAddRootPath = () => useAppStore((s) => s.addRootPath);
export const useRemoveRoot = () => useAppStore((s) => s.removeRoot);
export const useRescanRoot = () => useAppStore((s) => s.rescanRoot);
export const useRescanAll = () => useAppStore((s) => s.rescanAll);
export const useCancelScan = () => useAppStore((s) => s.cancel);
export const useEditTrack = () => useAppStore((s) => s.editTrack);
export const useSetTrackGenres = () => useAppStore((s) => s.setTrackGenres);
