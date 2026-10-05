/*
 * The app store: the library of roots, the state of a scan, and the indexed rows. Actions own the IPC
 * orchestration so components stay presentational and read narrow slices. A blocking scan runs through
 * one channel/progress/done/error runner; a quiet scan is the backend's background sync, whose events
 * drive the same scan state and patch the rows by id. The grid sorts and filters the rows client-side.
 */

// -- Library Imports --
import { create } from "zustand";
import { useMemo } from "react";

// -- Local Imports --
import {
  addRoot as addRootCmd,
  cancelScan,
  createScanChannel,
  getTracksByIds,
  listRoots,
  listTracks,
  removeMissingTracks as removeMissingTracksCmd,
  removeRoot as removeRootCmd,
  rescanAll as rescanAllCmd,
  rescanLibrary,
  setTrackEdit as setTrackEditCmd,
  setTrackGenres as setTrackGenresCmd,
} from "../lib/ipc";
import { pickFolder } from "../lib/dialog";
import { withRetry } from "../lib/withRetry";
import { mergeDelta, mergeRowsById, NO_DELTA, offlineRootIds, summaryFromSync } from "./librarySync";
import type { LibrarySummary, PendingDelta } from "./librarySync";

// -- Type Imports --
import type { GridFacet, GroupDimension } from "../components/tracks/trackFacets";

// -- State Imports --
// The organize store depends on this one (runtime only), so this back-reference is a safe cycle: it is
// touched solely inside actions, to mirror a peek edit into the album membership projection. The
// playlists store never touches this one, so importing it here is cycle-free; the purge reloads it so a
// gone track's cascaded slots leave the playlist view too.
import { useOrganizeStore } from "./organize/store";
import { usePlaylistsStore } from "./playlists/store";

// -- Type Imports --
import type { Channel } from "@tauri-apps/api/core";
import type {
  LibraryDelta,
  LibrarySyncStatus,
  LibrarySyncSummary,
  LibrarySyncTick,
  PurgeSummary,
  Root,
  RootWatchState,
  ScanProgress,
  ScanSummary,
  TrackEditFields,
  TrackRow,
} from "../types";

/** Where a scan is in its life: never started, running, finished, or failed. */
export type ScanStatus = "idle" | "scanning" | "done" | "error";

/**
 * How a scan presents. A blocking scan owns the screen (the first library scan, adding a folder): the
 * gate overlays its progress and replaces the shell on failure. A quiet scan runs behind the shell and
 * reports only through the title bar and Settings.
 */
export type ScanMode = "blocking" | "quiet";

/**
 * A surface that must not see rows shift under it: the albums-from-tags write, the gone-tracks purge
 * (its confirm and its run), and a running export. While any is held, sync deltas gather unapplied.
 */
export type SyncHold = "tagAlbums" | "purgeConfirm" | "purge" | "export";

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
  mode: ScanMode;
  progress: ScanProgress | null;
  // The last landed scan's or background session's summary. Kept while the next one runs, so its
  // offline roots stay flagged until a fresh summary replaces them.
  summary: LibrarySummary | null;
  error: string | null;
  // Epoch ms of the last background session's end; null until one has ended.
  checkedAt: number | null;
  // The tracks the last quiet scan added, stamped so the same count twice still reads as a new event.
  added: { n: number; at: number } | null;
}

interface AppStore {
  roots: Root[];
  booted: boolean;
  scan: ScanState;
  tracks: TrackRow[];
  // Each root's watch mode as the background sync last reported it.
  rootStates: RootWatchState[];
  // The surfaces currently holding sync deltas back, and the deltas gathered meanwhile.
  syncHolds: SyncHold[];
  pendingDelta: PendingDelta;
  // Each flat destination owns its own sort/search so their filters never leak into one another. The
  // library surface (All Tracks) also carries facet chips and a view mode; Files keeps only sort and
  // search. All of it lives here, not in the grid, so a re-scan (which unmounts the grid) does not lose it.
  librarySort: GridSort;
  librarySearch: string;
  libraryFacets: GridFacet[];
  // Narrows All Tracks to the tracks the Home box flags, alongside the facet chips: a track must pass
  // the facets AND be missing metadata. Its own slot so the chip clears apart from the facets.
  libraryMissingMetadata: boolean;
  // Narrows All Tracks to the tracks whose source file is gone from disk (missing_at set), alongside the
  // facet chips: a track must pass the facets AND be gone. Its own slot, parallel to missing-metadata, so
  // its chip clears apart and the purge action keys off it.
  libraryGone: boolean;
  libraryGroupBy: GroupDimension;
  libraryView: FilesViewMode;
  // A track a surface outside All Tracks asked to show: All Tracks opens its peek and scrolls it into
  // view, then clears the request. Null when nothing is pending.
  libraryRevealId: number | null;
  filesSort: GridSort;
  filesSearch: string;
  boot: () => Promise<void>;
  loadRoots: () => Promise<boolean>;
  addRoot: () => Promise<void>;
  addRootPath: (path: string) => Promise<boolean>;
  removeRoot: (id: number) => Promise<void>;
  rescanAll: () => Promise<void>;
  rescanQuiet: (rootId?: number) => Promise<void>;
  cancel: () => Promise<void>;
  loadTracks: () => Promise<boolean>;
  seedSync: (status: LibrarySyncStatus) => void;
  applySyncTick: (tick: LibrarySyncTick) => void;
  applySyncSummary: (summary: LibrarySyncSummary) => void;
  setRootStates: (states: RootWatchState[]) => void;
  queueDelta: (delta: LibraryDelta) => void;
  flushDelta: () => Promise<void>;
  holdSync: (hold: SyncHold) => void;
  releaseSync: (hold: SyncHold) => void;
  purgeGoneTracks: (trackIds: number[]) => Promise<PurgeSummary>;
  editTrack: (trackId: number, fields: TrackEditFields) => Promise<void>;
  setTrackGenres: (trackId: number, genreIds: number[]) => Promise<void>;
  setLibrarySort: (sort: GridSort) => void;
  setLibrarySearch: (search: string) => void;
  setLibraryFacets: (facets: GridFacet[]) => void;
  setLibraryMissingMetadata: (on: boolean) => void;
  setLibraryGone: (on: boolean) => void;
  setLibraryGroupBy: (groupBy: GroupDimension) => void;
  setLibraryView: (view: FilesViewMode) => void;
  revealLibraryTrack: (trackId: number) => void;
  clearLibraryReveal: () => void;
  setFilesSort: (sort: GridSort) => void;
  setFilesSearch: (search: string) => void;
  reset: () => void;
}

const idleScan: ScanState = {
  status: "idle",
  mode: "blocking",
  progress: null,
  summary: null,
  error: null,
  checkedAt: null,
  added: null,
};

// The backend's rejection when a scan already holds the lock; every scan command words it the same.
const SCAN_BUSY = "a scan is already running";

// The quiet error when the rows could not be reloaded after a background change. Never shown raw.
const RELOAD_FAILED = "library reload failed";

/** Whether a scan rejection is the busy guard rather than a real failure. */
function isScanBusy(error: unknown): boolean {
  return String(error).includes(SCAN_BUSY);
}

/** Whether the scan state belongs to a blocking scan still running, which nothing quiet may touch. */
function blockingRun(scan: ScanState): boolean {
  return scan.status === "scanning" && scan.mode === "blocking";
}

export const useAppStore = create<AppStore>((set, get) => {
  // Drives the scan state from a blocking job's progress and outcome, over a fresh channel. A
  // cancelled run still resolves with a summary, so it lands in 'done' with the partial index intact.
  // Returns the summary of a landed scan, or null, so the caller reloads only on a landed scan.
  const runScanJob = async (
    job: (channel: Channel<ScanProgress>) => Promise<ScanSummary>,
  ): Promise<ScanSummary | null> => {
    const before = get().scan;
    set({ scan: { ...before, status: "scanning", mode: "blocking", progress: null, error: null } });

    const channel = createScanChannel((progress) => {
      // scanned is monotonic on the backend; guard against an out-of-order tick regressing it.
      const prev = get().scan.progress;
      const scanned = prev ? Math.max(prev.scanned, progress.scanned) : progress.scanned;
      set((s) => ({ scan: { ...s.scan, progress: { ...progress, scanned } } }));
    });

    try {
      const summary = await job(channel);
      set((s) => ({ scan: { ...s.scan, status: "done", summary: { ...summary, source: "blocking" } } }));
      return summary;
    } catch (e) {
      // Background passes yield to this scan, so a busy lock means a user write is mid-flight. That
      // is worth a quiet note, never the full-screen failure.
      if (isScanBusy(e)) {
        set({ scan: { ...before, status: "error", mode: "quiet", error: String(e) } });
        return null;
      }
      set((s) => ({ scan: { ...s.scan, status: "error", error: String(e) } }));
      return null;
    }
  };

  // Reloads the roots, tracks and organization. Each read keeps its current rows on failure; the
  // result says whether all three landed.
  const refreshLibrary = async (): Promise<boolean> => {
    const roots = await get().loadRoots();
    const tracks = await get().loadTracks();
    const org = await useOrganizeStore.getState().refreshOrganization();
    return roots && tracks && org;
  };

  // Marks the last quiet check as failed, unless a blocking scan owns the state.
  const failQuietly = (error: string) => {
    const { scan } = get();
    if (blockingRun(scan)) return;
    set({ scan: { ...scan, status: "error", mode: "quiet", error } });
  };

  // Applies one batch of gathered deltas: fetch the changed rows and patch them in by id, falling
  // back to a full keep-on-error refresh on a reload or a failed fetch. Album membership rows carry
  // missing_at too, so a filed track also refreshes the organization.
  const applyDelta = async ({ ids, reload }: PendingDelta) => {
    if (!reload) {
      const rows = await getTracksByIds(ids).catch(() => null);
      if (rows) {
        set((s) => ({ tracks: mergeRowsById(s.tracks, rows) }));
        const changed = new Set(ids);
        const org = useOrganizeStore.getState();
        if (org.org.membership.some((m) => changed.has(m.track_id))) {
          if (!(await org.refreshOrganization())) failQuietly(RELOAD_FAILED);
        }
        return;
      }
    }
    if (!(await refreshLibrary())) failQuietly(RELOAD_FAILED);
  };

  // One flush at a time; a delta that lands mid-flush is picked up by the same loop.
  let flushing = false;

  return {
    roots: [],
    booted: false,
    scan: idleScan,
    tracks: [],
    rootStates: [],
    syncHolds: [],
    pendingDelta: NO_DELTA,
    librarySort: [],
    librarySearch: "",
    libraryFacets: [],
    libraryMissingMetadata: false,
    libraryGone: false,
    libraryGroupBy: "none",
    libraryView: "table",
    libraryRevealId: null,
    filesSort: [],
    filesSearch: "",

    boot: async () => {
      await get().loadRoots();
      // Open into the last index when the library has roots; the background sync runs its own startup
      // pass to catch up on what changed while the app was closed.
      if (get().roots.length > 0) await get().loadTracks();
      set({ booted: true });
    },

    // A read that still fails after its retries keeps the current roots: at boot that is the empty
    // list, and later a failed reload never drops a stocked library back to onboarding.
    loadRoots: async () => {
      try {
        // Retried: an early boot read can reject before managed state is ready. An empty result is not
        // a rejection, so a genuinely empty library still resolves at once and shows onboarding.
        const roots = await withRetry(listRoots);
        set({ roots });
        return true;
      } catch {
        return false;
      }
    },

    addRoot: async () => {
      const path = await pickFolder();
      if (!path) return;
      const summary = await runScanJob((channel) => addRootCmd(path, channel));
      if (summary) {
        await get().loadRoots();
        await get().loadTracks();
      }
    },

    // Indexes an already-known folder as a root, the same ingest addRoot runs once a folder is picked.
    // The splicer hands its finished output folder here to bring the fresh cuts into the library.
    addRootPath: async (path) => {
      const summary = await runScanJob((channel) => addRootCmd(path, channel));
      if (summary) {
        await get().loadRoots();
        await get().loadTracks();
      }
      return summary != null;
    },

    removeRoot: async (id) => {
      await removeRootCmd(id);
      await get().loadRoots();
      await get().loadTracks();
    },

    // The gate's retry after a failed blocking scan, so it stays blocking. Every other rescan is quiet.
    rescanAll: async () => {
      const summary = await runScanJob((channel) => rescanAllCmd(channel));
      if (summary) await get().loadTracks();
    },

    // The one entry for every quiet rescan: one root when given, else the whole library. It only
    // queues a background pass, joining a running session; progress and results arrive as sync events.
    rescanQuiet: async (rootId) => {
      try {
        await rescanLibrary(rootId);
      } catch (e) {
        failQuietly(String(e));
      }
    },

    cancel: async () => {
      await cancelScan();
    },

    // Like loadRoots, a read that still fails after its retries keeps the current rows, so a stocked
    // library is never emptied by one failed read.
    loadTracks: async () => {
      try {
        // Retried for the same boot-race reason as loadRoots: it runs right after the roots hydrate.
        const { rows } = await withRetry(() => listTracks({}));
        set({ tracks: rows });
        return true;
      } catch {
        return false;
      }
    },

    // ---- Background sync ----

    // The snapshot read once on subscribe, for whatever the sync sent before anyone listened.
    seedSync: (status) => {
      set({ rootStates: status.roots });
      if (status.running) {
        get().applySyncTick({
          running: true,
          scanned: status.scanned,
          total: status.total,
          deferred: 0,
        });
      }
    },

    // A running session reads as a quiet scan; its last tick ends it. A blocking scan owns the state
    // while it runs, so ticks are ignored until it lands.
    applySyncTick: (tick) => {
      const { scan } = get();
      if (blockingRun(scan)) return;
      if (tick.running) {
        set({
          scan: {
            ...scan,
            status: "scanning",
            mode: "quiet",
            error: null,
            progress: {
              phase: tick.total > 0 ? "reading" : "enumerating",
              scanned: tick.scanned,
              total: tick.total,
              errors: 0,
              done: false,
            },
          },
        });
        return;
      }
      if (scan.status !== "scanning") return;
      set({ scan: { ...scan, status: "done", mode: "quiet", progress: null } });
    },

    // A session's end: its totals become the summary line, it counts as a check, and what it added
    // shows as the passing caption. Unreadable files are reported, not treated as a failed check.
    applySyncSummary: (totals) => {
      const { scan } = get();
      const at = Date.now();
      set({
        scan: {
          ...scan,
          summary: summaryFromSync(totals),
          checkedAt: at,
          added: totals.inserted > 0 ? { n: totals.inserted, at } : scan.added,
        },
      });
      // The roots' track counts are not in the deltas, so read them fresh.
      void get()
        .loadRoots()
        .then((ok) => {
          if (!ok) failQuietly(RELOAD_FAILED);
        });
    },

    setRootStates: (rootStates) => set({ rootStates }),

    queueDelta: (delta) => {
      set((s) => ({ pendingDelta: mergeDelta(s.pendingDelta, delta) }));
      void get().flushDelta();
    },

    // Applies the gathered deltas unless a surface holds them back; a release flushes again.
    flushDelta: async () => {
      if (flushing) return;
      flushing = true;
      try {
        while (get().syncHolds.length === 0) {
          const pending = get().pendingDelta;
          if (!pending.reload && pending.ids.length === 0) break;
          set({ pendingDelta: NO_DELTA });
          await applyDelta(pending);
        }
      } finally {
        flushing = false;
      }
    },

    holdSync: (hold) => {
      set((s) => (s.syncHolds.includes(hold) ? s : { syncHolds: [...s.syncHolds, hold] }));
    },

    releaseSync: (hold) => {
      set((s) => ({ syncHolds: s.syncHolds.filter((h) => h !== hold) }));
      void get().flushDelta();
    },

    // Purges the gone tracks in `trackIds` for good, then reloads every projection they touched: the
    // track store (All Tracks, History, Home), the roots (their counts drop), the organize view (an
    // emptied album is swept), and the playlists (a gone track's slots cascade away). The backend guards
    // the DELETE on missing_at, so a present id can never be dropped. Sync deltas wait until it is done.
    purgeGoneTracks: async (trackIds) => {
      get().holdSync("purge");
      try {
        const summary = await removeMissingTracksCmd(trackIds);
        await get().loadRoots();
        await get().loadTracks();
        await useOrganizeStore.getState().loadOrganization();
        await usePlaylistsStore.getState().load();
        return summary;
      } finally {
        get().releaseSync("purge");
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

    setLibrarySort: (librarySort) => set({ librarySort }),
    setLibrarySearch: (librarySearch) => set({ librarySearch }),
    setLibraryFacets: (libraryFacets) => set({ libraryFacets }),
    setLibraryMissingMetadata: (libraryMissingMetadata) => set({ libraryMissingMetadata }),
    setLibraryGone: (libraryGone) => set({ libraryGone }),
    setLibraryGroupBy: (libraryGroupBy) => set({ libraryGroupBy }),
    setLibraryView: (libraryView) => set({ libraryView }),
    revealLibraryTrack: (libraryRevealId) => set({ libraryRevealId }),
    clearLibraryReveal: () => set({ libraryRevealId: null }),
    setFilesSort: (filesSort) => set({ filesSort }),
    setFilesSearch: (filesSearch) => set({ filesSearch }),

    reset: () =>
      set({
        roots: [],
        booted: false,
        scan: idleScan,
        tracks: [],
        rootStates: [],
        syncHolds: [],
        pendingDelta: NO_DELTA,
        librarySort: [],
        librarySearch: "",
        libraryFacets: [],
        libraryMissingMetadata: false,
        libraryGone: false,
        libraryGroupBy: "none",
        libraryView: "table",
        libraryRevealId: null,
        filesSort: [],
        filesSearch: "",
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
export const useScanSummary = (): LibrarySummary | null =>
  useAppStore((s) => s.scan.summary);
export const useScanError = (): string | null => useAppStore((s) => s.scan.error);
export const useScanMode = (): ScanMode => useAppStore((s) => s.scan.mode);
export const useScanCheckedAt = (): number | null => useAppStore((s) => s.scan.checkedAt);
export const useScanAdded = (): { n: number; at: number } | null =>
  useAppStore((s) => s.scan.added);

const NO_ROOTS: number[] = [];

/** Whether a blocking scan is running; a quiet one never locks the folder actions. */
export const useBlockingScan = (): boolean => useAppStore((s) => blockingRun(s.scan));

/**
 * The roots to flag offline: unreachable by the sync's latest report, or skipped by the last summary.
 * Built here from two stable references, so the fresh list never destabilizes a subscription.
 */
export const useOfflineRoots = (): number[] => {
  const states = useAppStore((s) => s.rootStates);
  const lastSummary = useAppStore((s) => s.scan.summary?.offline_roots ?? NO_ROOTS);
  return useMemo(() => offlineRootIds(states, lastSummary), [states, lastSummary]);
};

/** Whether the last quiet scan, or the reload after it, failed. */
export const useQuietCheckFailed = (): boolean =>
  useAppStore((s) => s.scan.status === "error" && s.scan.mode === "quiet");

/** How many indexed tracks have their source file gone from disk. */
export const useGoneCount = (): number =>
  useAppStore((s) => {
    let n = 0;
    for (const r of s.tracks) if (r.missing_at != null) n += 1;
    return n;
  });

export const useTracks = (): TrackRow[] => useAppStore((s) => s.tracks);

/**
 * The live row for one track id, or undefined when it is gone. Returns the stored row reference
 * itself, so a subscriber re-renders only when that row is patched - the detail peek reads through
 * this to see its own optimistic edits, rather than the stale snapshot held at select time.
 */
export const useTrack = (id: number): TrackRow | undefined =>
  useAppStore((s) => s.tracks.find((r) => r.id === id));

export const useLibrarySort = (): GridSort => useAppStore((s) => s.librarySort);
export const useLibrarySearch = (): string => useAppStore((s) => s.librarySearch);
export const useLibraryFacets = (): GridFacet[] => useAppStore((s) => s.libraryFacets);
export const useLibraryMissingMetadata = (): boolean =>
  useAppStore((s) => s.libraryMissingMetadata);
export const useLibraryGone = (): boolean => useAppStore((s) => s.libraryGone);
export const useLibraryGroupBy = (): GroupDimension => useAppStore((s) => s.libraryGroupBy);
export const useLibraryView = (): FilesViewMode => useAppStore((s) => s.libraryView);
export const useLibraryRevealId = (): number | null => useAppStore((s) => s.libraryRevealId);
export const useFilesSort = (): GridSort => useAppStore((s) => s.filesSort);
export const useFilesSearch = (): string => useAppStore((s) => s.filesSearch);

export const useSetLibrarySort = () => useAppStore((s) => s.setLibrarySort);
export const useSetLibrarySearch = () => useAppStore((s) => s.setLibrarySearch);
export const useSetLibraryFacets = () => useAppStore((s) => s.setLibraryFacets);
export const useSetLibraryMissingMetadata = () => useAppStore((s) => s.setLibraryMissingMetadata);
export const useSetLibraryGone = () => useAppStore((s) => s.setLibraryGone);
export const usePurgeGoneTracks = () => useAppStore((s) => s.purgeGoneTracks);
export const useSetLibraryGroupBy = () => useAppStore((s) => s.setLibraryGroupBy);
export const useSetLibraryView = () => useAppStore((s) => s.setLibraryView);
export const useRevealLibraryTrack = () => useAppStore((s) => s.revealLibraryTrack);
export const useClearLibraryReveal = () => useAppStore((s) => s.clearLibraryReveal);
export const useSetFilesSort = () => useAppStore((s) => s.setFilesSort);
export const useSetFilesSearch = () => useAppStore((s) => s.setFilesSearch);

export const useBoot = () => useAppStore((s) => s.boot);
export const useLoadRoots = () => useAppStore((s) => s.loadRoots);
export const useAddRoot = () => useAppStore((s) => s.addRoot);
export const useAddRootPath = () => useAppStore((s) => s.addRootPath);
export const useRemoveRoot = () => useAppStore((s) => s.removeRoot);
export const useRescanAll = () => useAppStore((s) => s.rescanAll);
export const useRescanQuiet = () => useAppStore((s) => s.rescanQuiet);
export const useHoldSync = () => useAppStore((s) => s.holdSync);
export const useReleaseSync = () => useAppStore((s) => s.releaseSync);
export const useCancelScan = () => useAppStore((s) => s.cancel);
export const useEditTrack = () => useAppStore((s) => s.editTrack);
export const useSetTrackGenres = () => useAppStore((s) => s.setTrackGenres);
