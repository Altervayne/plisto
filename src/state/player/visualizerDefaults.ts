/*
 * The visualizer defaults store: every stored album and track default, plus the session's temporary
 * override, which is never persisted. Stored strings are kept verbatim; the resolver decides what they
 * mean. A failed boot read leaves the store `failed`, never an empty `ready`, so a library with defaults
 * is never shown as having none; a failed reload keeps what is already held.
 */

// -- Library Imports --
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// -- IPC Imports --
import { getVisualizerDefaults, setAlbumVisualizer, setTrackVisualizer } from "../../lib/ipc";
import { withRetry } from "../../lib/withRetry";

// -- State Imports --
import { usePlayerStore } from "./store";
import { storedDefaultsOf, writeEndsOverride } from "./visualizerResolve";

// -- Type Imports --
import type { VisualizerKind } from "./visualizerKind";
import type { DefaultsStatus, TrackPlace, VisualizerOverride } from "./visualizerResolve";
import type { VisualizerDefaults } from "../../types";

type KindMap = Readonly<Record<number, string>>;

interface VisualizerDefaultsStore {
  status: DefaultsStatus;
  albums: KindMap;
  tracks: KindMap;
  override: VisualizerOverride | null;

  load: () => Promise<boolean>;
  setAlbumDefault: (albumId: number, kind: VisualizerKind | null) => Promise<boolean>;
  setTrackDefault: (trackId: number, kind: VisualizerKind | null) => Promise<boolean>;
  setOverride: (override: VisualizerOverride) => void;
  clearOverride: () => void;
}

function toMaps(read: VisualizerDefaults): { albums: KindMap; tracks: KindMap } {
  return {
    albums: Object.fromEntries(read.albums.map((a) => [a.album_id, a.kind])),
    tracks: Object.fromEntries(read.tracks.map((t) => [t.track_id, t.kind])),
  };
}

function withEntry(map: KindMap, id: number, kind: string | null): KindMap {
  const next = { ...map };
  if (kind == null) delete next[id];
  else next[id] = kind;
  return next;
}

export const useVisualizerDefaults = create<VisualizerDefaultsStore>((set, get) => {
  // One read on the wire at a time: a boundary retry while the boot read still backs off joins it.
  let inflight: Promise<boolean> | null = null;

  // Writes one tier optimistically. Only a kind ends an override: clearing a default keeps the
  // temporary pick. A rejected write restores the entry and the override, unless a later change
  // already replaced them.
  const write = async (
    tier: "albums" | "tracks",
    id: number,
    kind: VisualizerKind | null,
    persist: () => Promise<void>,
  ): Promise<boolean> => {
    // Before the defaults are read, an optimistic entry would be lost under the read that lands.
    if (get().status !== "ready") return false;
    const entry = (s: VisualizerDefaultsStore, value: string | null) =>
      tier === "albums" ? { albums: withEntry(s.albums, id, value) } : { tracks: withEntry(s.tracks, id, value) };
    const prev = get()[tier][id] ?? null;
    const override = get().override;
    const target = tier === "albums" ? { album: id } : { track: id };
    const ends = kind != null && writeEndsOverride(override, target, usePlayerStore.getState().status.track_id);
    set((s) => ({ ...entry(s, kind), ...(ends ? { override: null } : {}) }));
    try {
      await persist();
      return true;
    } catch {
      set((s) => ({
        ...((s[tier][id] ?? null) === kind ? entry(s, prev) : {}),
        ...(ends && s.override == null ? { override } : {}),
      }));
      return false;
    }
  };

  return {
    status: "loading",
    albums: {},
    tracks: {},
    override: null,

    load: () => {
      if (inflight) return inflight;
      inflight = (async () => {
        if (get().status === "failed") set({ status: "loading" });
        try {
          const read = await withRetry(getVisualizerDefaults);
          set({ status: "ready", ...toMaps(read) });
          return true;
        } catch {
          if (get().status !== "ready") set({ status: "failed" });
          return false;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    setAlbumDefault: (albumId, kind) => write("albums", albumId, kind, () => setAlbumVisualizer(albumId, kind)),

    setTrackDefault: (trackId, kind) => write("tracks", trackId, kind, () => setTrackVisualizer(trackId, kind)),

    setOverride: (override) => set({ override }),

    clearOverride: () => set({ override: null }),
  };
});

// -- Selectors (narrow: each returns one primitive or one stable/shallow-stable reference) --

export const useVisualizerDefaultsStatus = (): DefaultsStatus => useVisualizerDefaults((s) => s.status);

export const useVisualizerOverride = (): VisualizerOverride | null => useVisualizerDefaults((s) => s.override);

/** The stored strings that apply to a place. Shallow-stable, so a fresh place object does not churn. */
export const useStoredDefaults = (place: TrackPlace): { trackDefault: string | null; albumDefault: string | null } =>
  useVisualizerDefaults(useShallow((s) => storedDefaultsOf(place, s.albums, s.tracks)));
