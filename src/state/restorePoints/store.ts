/*
 * The restore points store: the point list with the folder's disk use, the dry run, and the restore.
 * A restore reuses album, playlist, slot and genre ids, so after one every held reference is dropped,
 * not only the undo history: the albums and playlists projections go back to not ready (their writes
 * are refused meanwhile), the command runs, and the loaders start again over the restored rows. A
 * refusal or a failure changed nothing, so it only starts the loaders again and keeps the history.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { useAppStore, useScanStatus } from "../store";
import { orgLoader, useOrganizeStore } from "../organize/store";
import { playlistsLoader } from "../playlists/store";
import { useCollectionStore } from "../collection/store";
import { useVisualizerDefaults } from "../player/visualizerDefaults";
import { reportLibraryChange } from "../plugins/libraryWatch";

import { usePlayerStore } from "../player/store";
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";

// -- Utils Imports --
import { invalidateAllAlbumCovers } from "../../components/albums/albumCoverBatch";

// -- IPC Imports --
import {
  listRestorePoints as ipcListRestorePoints,
  planRestore as ipcPlanRestore,
  restoreFromPoint as ipcRestoreFromPoint,
} from "../../lib/ipc";

// -- Type Imports --
import type { RestorePointRow, RestoreRefusal, RestoreSummary } from "../../types";

/** The keys the UI translates: a refusal's code, or `failed` for an error that carries no code. */
export type RestoreFailureKey = RestoreRefusal["code"] | "failed";

/** Why a plan or restore did not go ahead. `detail` is the refusal's message or format, or the error text. */
export interface RestoreFailure {
  key: RestoreFailureKey;
  detail: string | null;
}

export type PlanResult =
  | { kind: "ready"; summary: RestoreSummary }
  | { kind: "refused"; failure: RestoreFailure };

/** How the last restore ended. `beforePoint` is the point that undoes it; null when nothing was saved. */
export type RestoreResult =
  | { kind: "done"; file: string; summary: RestoreSummary; beforePoint: string | null }
  | { kind: "refused"; file: string; failure: RestoreFailure };

interface RestorePointsStore {
  points: RestorePointRow[];
  diskPoints: number;
  diskBytes: number;
  // True once a list has landed; a failed read keeps the rows held.
  loaded: boolean;
  error: string | null;
  // True from the start of a restore until the library has been read again.
  running: boolean;
  result: RestoreResult | null;
  // Bumped when a restore lands, so a view holding an album or playlist id in its own state can close it.
  generation: number;

  load: () => Promise<void>;
  plan: (file: string) => Promise<PlanResult>;
  /** Restores `file`; null when a restore is already running. */
  restore: (file: string) => Promise<RestoreResult | null>;
  clearResult: () => void;
}

/** A refusal as the UI shows it. */
export function refusalFailure(reason: RestoreRefusal): RestoreFailure {
  switch (reason.code) {
    case "newer":
      return { key: "newer", detail: String(reason.format) };
    case "busy":
      return { key: "busy", detail: null };
    default:
      return { key: reason.code, detail: reason.message };
  }
}

const failed = (e: unknown): RestoreFailure => ({ key: "failed", detail: String(e) });

/**
 * Ends the loaders' hold and reads both projections afresh; the only way back to ready. Anything read
 * during the hold was refused, so nothing stale is trusted. After a refusal this re-reads organization
 * and playlists once over unchanged data, which is harmless. Never rejects.
 */
const startProjections = (): Promise<unknown> => {
  orgLoader.release();
  playlistsLoader.release();
  return Promise.all([orgLoader.start(), playlistsLoader.start()]);
};

/**
 * Drops every held reference to an album, playlist, slot or genre id, whose numbers are reused.
 * Bumps the generation, which views holding an id in component state watch.
 */
function dropHeldIds(): void {
  const organize = useOrganizeStore.getState();
  organize.resetHistory();
  organize.clearSelection();
  organize.clearError();
  useCollectionStore.getState().resetAlbumRefs();
  // The persisted Browse focus names an album id; an empty value reads as no focus.
  usePreferencesStore.getState().setPreference(PREF_KEYS.collectionBrowseFocus, "");
  // The queue keeps its tracks (track ids are stable); only a source naming an album or playlist goes,
  // so the player shows no "playing from" line rather than a name that may now be another container.
  const player = usePlayerStore.getState();
  if (player.playingFrom?.kind === "album" || player.playingFrom?.kind === "playlist") {
    usePlayerStore.setState({ playingFrom: null });
  }
  // Cached album covers are keyed by album id.
  invalidateAllAlbumCovers();
  useRestorePointsStore.setState((s) => ({ generation: s.generation + 1 }));
}

export const useRestorePointsStore = create<RestorePointsStore>((set, get) => ({
  points: [],
  diskPoints: 0,
  diskBytes: 0,
  loaded: false,
  error: null,
  running: false,
  result: null,
  generation: 0,

  load: async () => {
    try {
      const list = await ipcListRestorePoints();
      set({
        points: list.points,
        diskPoints: list.disk_points,
        diskBytes: list.disk_bytes,
        loaded: true,
        error: null,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  plan: async (file) => {
    try {
      const preview = await ipcPlanRestore(file);
      return preview.kind === "ready"
        ? { kind: "ready", summary: preview.summary }
        : { kind: "refused", failure: refusalFailure(preview.reason) };
    } catch (e) {
      return { kind: "refused", failure: failed(e) };
    }
  },

  restore: async (file) => {
    if (get().running) return null;
    // A running scan holds the library; the command would refuse as busy, so it is not even asked.
    if (useAppStore.getState().scan.status === "scanning") {
      return finish(set, { kind: "refused", file, failure: { key: "busy", detail: null } });
    }
    set({ running: true, result: null });
    // Sync deltas gather unapplied, and the loaders are held not ready: every albums and playlists
    // write and read is refused until the restore ends.
    useAppStore.getState().holdSync("restore");
    orgLoader.hold();
    playlistsLoader.hold();
    try {
      let outcome;
      try {
        outcome = await ipcRestoreFromPoint(file);
      } catch (e) {
        await startProjections();
        return finish(set, { kind: "refused", file, failure: failed(e) });
      }
      if (outcome.kind === "refused") {
        await startProjections();
        return finish(set, { kind: "refused", file, failure: refusalFailure(outcome.reason) });
      }
      // A throw here must not leave the loaders held until relaunch.
      try {
        dropHeldIds();
      } catch (e) {
        console.warn("Dropping held references after a restore failed:", e);
      }
      await startProjections();
      // The organization read carries the genre vocabulary; the rest reload beside it.
      await Promise.all([
        useAppStore.getState().loadTracks(),
        useVisualizerDefaults.getState().load(),
        get().load(),
      ]);
      reportLibraryChange({ track_ids: null, albums: true, playlists: true });
      return finish(set, {
        kind: "done",
        file,
        summary: outcome.summary,
        beforePoint: outcome.before_point,
      });
    } finally {
      useAppStore.getState().releaseSync("restore");
      set({ running: false });
    }
  },

  clearResult: () => set({ result: null }),
}));

function finish(
  set: (partial: Partial<RestorePointsStore>) => void,
  result: RestoreResult,
): RestoreResult {
  set({ result });
  return result;
}

// -- Selectors --

export const useRestoreGeneration = (): number => useRestorePointsStore((s) => s.generation);

export const useRestoreRunning = (): boolean => useRestorePointsStore((s) => s.running);

/** Whether Restore can be asked for: none is running and no scan holds the library. */
export const useRestoreAllowed = (): boolean => {
  // Both hooks run on every render, so the hook order never depends on whether a restore runs.
  const running = useRestoreRunning();
  const scanning = useScanStatus() === "scanning";
  return !running && !scanning;
};
