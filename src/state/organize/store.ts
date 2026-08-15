/*
 * The organize store: the album/membership projection plus its session undo stack, kept apart from the
 * scan store so a re-scan never touches editing state. The five in-place edits commit through the pure
 * command engine - capture the prior value, apply optimistically, push onto `past`, clear `future`, and
 * fire the write - so undo/redo is a stack of inverse Commands. Create, delete and cover-set are
 * structural: they reload from the backend and clear the whole history, since a new or gone album is the
 * natural undo boundary. Selection is keyed by track_id so it survives sort and filter, and never lands
 * on the stack.
 */

// -- Library Imports --
import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// -- State Imports --
import { useAppStore } from "../store";

// -- Engine Imports --
import { applyCommand, commandToIpc, invertCommand } from "./orgCommands";

// -- IPC Imports --
import {
  addAlbumGenre as ipcAddAlbumGenre,
  createAlbum as ipcCreateAlbum,
  createGenre as ipcCreateGenre,
  createSingle as ipcCreateSingle,
  deleteAlbum as ipcDeleteAlbum,
  deleteGenre as ipcDeleteGenre,
  genreRemovalImpact as ipcGenreRemovalImpact,
  listGenres as ipcListGenres,
  loadOrganization as ipcLoadOrganization,
  mergeGenres as ipcMergeGenres,
  removeAlbumGenre as ipcRemoveAlbumGenre,
  renameGenre as ipcRenameGenre,
  setAlbumCover as ipcSetAlbumCover,
  setTrackGenres as ipcSetTrackGenres,
} from "../../lib/ipc";

// -- Type Imports --
import type {
  AlbumFields,
  AlbumRow,
  AlbumTrackRow,
  GenreRow,
  TrackOverride,
  TrackPlacement,
  TrackRow,
} from "../../types";
import type { Command, OrgState, Placement } from "./orgCommands";

interface OrganizeStore {
  org: OrgState;
  // The genre vocabulary sits outside the undoable projection: a rename or a merge is not an undo step.
  genres: GenreRow[];
  past: Command[];
  future: Command[];
  selection: Set<number>;
  error: string | null;

  loadOrganization: () => Promise<void>;
  loadGenres: () => Promise<void>;
  clearError: () => void;

  commitAlbumFields: (albumId: number, next: AlbumFields) => void;
  commitTrackOverrides: (albumId: number, trackId: number, next: TrackOverride) => void;
  reorderTracks: (albumId: number, nextOrder: number[]) => void;
  setAlbumLayout: (albumId: number, nextPlacements: TrackPlacement[]) => void;
  assignTracks: (albumId: number, trackIds: number[]) => void;
  unassignTracks: (albumId: number, trackIds: number[]) => void;

  undo: () => void;
  redo: () => void;

  createAlbum: (fields: AlbumFields, trackIds: number[]) => Promise<number>;
  createSingle: (trackId: number) => Promise<number>;
  deleteAlbum: (albumId: number) => Promise<void>;
  setAlbumCover: (albumId: number, srcPath: string) => Promise<void>;

  createGenre: (name: string) => Promise<number>;
  renameGenre: (id: number, name: string) => Promise<void>;
  deleteGenre: (id: number) => Promise<void>;
  mergeGenres: (sourceId: number, targetId: number) => Promise<void>;
  genreRemovalImpact: (id: number) => Promise<number>;

  addAlbumGenre: (albumId: number, genreId: number) => void;
  removeAlbumGenre: (albumId: number, genreId: number) => void;
  setTrackGenres: (trackId: number, genreIds: number[]) => void;

  toggleSelect: (trackId: number) => void;
  selectOnly: (trackId: number) => void;
  selectRange: (trackIds: number[]) => void;
  addSelection: (trackIds: number[]) => void;
  removeSelection: (trackIds: number[]) => void;
  clearSelection: () => void;
}

const emptyOrg: OrgState = { albums: [], membership: [] };

export const useOrganizeStore = create<OrganizeStore>((set, get) => {
  // Resyncs from the DB when a write fails: the optimistic projection is now ahead of it, so a reload
  // is the correct recovery. The undo stack is left intact - a reload is not itself an undo boundary.
  const reloadOnFailure = (): void => {
    void get().loadOrganization();
    set({ error: "A change could not be saved. Reloaded from the library." });
  };

  // Fires a command's write, and on a failed persist resyncs from the DB and surfaces a quiet error.
  const persist = (cmd: Command): void => {
    void commandToIpc(cmd).catch(reloadOnFailure);
  };

  // Fires a genre-assignment write off a projection already patched to `membership`. Genre is a
  // distinct edit that never lands on the undo stack, so this stays off the command engine: patch
  // optimistically, write, and on failure fall back to the same reload recovery.
  const mutateGenres = (membership: AlbumTrackRow[], ipcCall: () => Promise<void>): void => {
    set((s) => ({ org: { ...s.org, membership }, error: null }));
    void ipcCall().catch(reloadOnFailure);
  };

  // Applies a committed edit: optimistic projection, push onto the undo stack, drop the redo branch,
  // then fire the write. A committed edit always invalidates any pending redo.
  const commit = (cmd: Command): void => {
    set((s) => ({ org: applyCommand(s.org, cmd), past: [...s.past, cmd], future: [], error: null }));
    persist(cmd);
  };

  // Builds the appended row for a track joining `albumId` at `trackNo`. Track-level fields come from the
  // track's current membership row when it is moving, or the scan index when it is loose.
  const appendedRow = (albumId: number, trackId: number, trackNo: number): AlbumTrackRow | null => {
    const current = get().org.membership.find((r) => r.track_id === trackId);
    if (current) {
      return {
        ...current,
        album_id: albumId,
        track_no: trackNo,
        disc_no: 1,
        title_override: null,
        artist_override: null,
      };
    }
    const track = useAppStore.getState().tracks.find((t) => t.id === trackId);
    if (!track) return null;
    return {
      album_id: albumId,
      track_id: trackId,
      source_path: track.source_path,
      filename: track.filename,
      duration_secs: track.duration_secs,
      track_no: trackNo,
      disc_no: 1,
      raw_title: track.raw_title,
      raw_artist: track.raw_artist,
      title_override: null,
      artist_override: null,
      has_embedded_cover: null,
      missing_at: track.missing_at,
      genre_ids: [],
    };
  };

  return {
    org: emptyOrg,
    genres: [],
    past: [],
    future: [],
    selection: new Set<number>(),
    error: null,

    loadOrganization: async () => {
      try {
        const snapshot = await ipcLoadOrganization();
        set({
          org: { albums: snapshot.albums, membership: snapshot.membership },
          genres: snapshot.genres,
        });
      } catch {
        set({ org: emptyOrg });
      }
    },

    // A light vocabulary-only refresh, for a surface that opens without a full org load.
    loadGenres: async () => {
      try {
        set({ genres: await ipcListGenres() });
      } catch {
        set({ genres: [] });
      }
    },

    clearError: () => set({ error: null }),

    commitAlbumFields: (albumId, next) => {
      const album = get().org.albums.find((a) => a.id === albumId);
      if (!album) return;
      const prev: AlbumFields = {
        title: album.title,
        album_artist: album.album_artist,
        year: album.year,
        genre: album.genre,
      };
      if (sameAlbumFields(prev, next)) return;
      commit({ kind: "setAlbumFields", albumId, next, prev });
    },

    commitTrackOverrides: (albumId, trackId, next) => {
      const row = get().org.membership.find(
        (r) => r.album_id === albumId && r.track_id === trackId,
      );
      if (!row) return;
      const prev: TrackOverride = {
        title_override: row.title_override,
        artist_override: row.artist_override,
        track_no: row.track_no,
        disc_no: row.disc_no,
      };
      if (sameOverride(prev, next)) return;
      commit({ kind: "setTrackOverrides", albumId, trackId, next, prev });
    },

    reorderTracks: (albumId, nextOrder) => {
      const prevOrder = get()
        .org.membership.filter((r) => r.album_id === albumId)
        .sort((a, b) => (a.track_no ?? 0) - (b.track_no ?? 0))
        .map((r) => r.track_id);
      if (sameOrder(prevOrder, nextOrder)) return;
      commit({ kind: "reorderTracks", albumId, nextOrder, prevOrder });
    },

    // Captures the album's current placements as `prev`, then commits the disc grouping and per-disc
    // numbering the caller computed. The list routes every within-disc reorder and disc move here, so
    // the stored track_no is always the per-disc position.
    setAlbumLayout: (albumId, nextPlacements) => {
      const prev: TrackPlacement[] = get()
        .org.membership.filter((r) => r.album_id === albumId)
        .map((r) => ({ track_id: r.track_id, disc_no: r.disc_no, track_no: r.track_no }));
      if (sameLayout(prev, nextPlacements)) return;
      commit({ kind: "setAlbumLayout", albumId, next: nextPlacements, prev });
    },

    assignTracks: (albumId, trackIds) => {
      const membership = get().org.membership;
      const before: Placement[] = [];
      const after: Placement[] = [];
      const affected: number[] = [];
      let nextNo = membership
        .filter((r) => r.album_id === albumId)
        .reduce((max, r) => Math.max(max, r.track_no ?? 0), 0);

      for (const trackId of trackIds) {
        const current = membership.find((r) => r.track_id === trackId);
        // A track already in this album is left untouched, matching the backend move-or-add.
        if (current && current.album_id === albumId) continue;
        const row = appendedRow(albumId, trackId, nextNo + 1);
        if (!row) continue;
        nextNo += 1;
        affected.push(trackId);
        before.push(current ? { assigned: true, row: current } : { assigned: false, trackId });
        after.push({ assigned: true, row });
      }

      if (affected.length === 0) return;
      commit({ kind: "assign", albumId, trackIds: affected, before, after });
    },

    unassignTracks: (albumId, trackIds) => {
      const membership = get().org.membership;
      const before: Placement[] = [];
      const after: Placement[] = [];
      const affected: number[] = [];

      for (const trackId of trackIds) {
        const row = membership.find((r) => r.album_id === albumId && r.track_id === trackId);
        if (!row) continue;
        affected.push(trackId);
        before.push({ assigned: true, row });
        after.push({ assigned: false, trackId });
      }

      if (affected.length === 0) return;
      commit({ kind: "unassign", albumId, trackIds: affected, before, after });
    },

    undo: () => {
      const { past } = get();
      if (past.length === 0) return;
      const cmd = past[past.length - 1];
      const inverse = invertCommand(cmd);
      set((s) => ({
        org: applyCommand(s.org, inverse),
        past: s.past.slice(0, -1),
        future: [...s.future, cmd],
        error: null,
      }));
      persist(inverse);
    },

    redo: () => {
      const { future } = get();
      if (future.length === 0) return;
      const cmd = future[future.length - 1];
      set((s) => ({
        org: applyCommand(s.org, cmd),
        future: s.future.slice(0, -1),
        past: [...s.past, cmd],
        error: null,
      }));
      persist(cmd);
    },

    createAlbum: async (fields, trackIds) => {
      const row = await ipcCreateAlbum(fields, trackIds);
      await get().loadOrganization();
      // A new album is a structural change: past references stay valid, but the future branch cannot.
      set({ past: [], future: [] });
      return row.id;
    },

    createSingle: async (trackId) => {
      const row = await ipcCreateSingle(trackId);
      await get().loadOrganization();
      // Promoting a loose track is structural, same as create: the future branch cannot survive it.
      set({ past: [], future: [] });
      return row.id;
    },

    deleteAlbum: async (albumId) => {
      await ipcDeleteAlbum(albumId);
      await get().loadOrganization();
      // A gone album could leave the stack pointing at absent rows, so clear the whole history.
      set({ past: [], future: [] });
    },

    setAlbumCover: async (albumId, srcPath) => {
      await ipcSetAlbumCover(albumId, srcPath);
      await get().loadOrganization();
    },

    // Vocabulary edits are structural, like create/delete album: hit the backend, then resync. Create
    // and rename touch only the vocabulary, so a genre refresh is enough. Delete and merge also rewrite
    // membership genre_ids, so they reload the whole projection to keep the drawer rows true.
    createGenre: async (name) => {
      try {
        const row = await ipcCreateGenre(name);
        await get().loadGenres();
        return row.id;
      } catch (e) {
        set({ error: "A genre could not be added." });
        throw e;
      }
    },

    renameGenre: async (id, name) => {
      try {
        await ipcRenameGenre(id, name);
      } catch {
        // A rename onto another genre's folded key is rejected: surface it and reload to drop the
        // optimistic name the field showed.
        set({ error: "That genre name is already in use." });
      }
      await get().loadGenres();
    },

    deleteGenre: async (id) => {
      try {
        await ipcDeleteGenre(id);
        await get().loadOrganization();
      } catch {
        set({ error: "A genre could not be removed." });
      }
    },

    mergeGenres: async (sourceId, targetId) => {
      try {
        await ipcMergeGenres(sourceId, targetId);
        await get().loadOrganization();
      } catch {
        set({ error: "Those genres could not be merged." });
      }
    },

    genreRemovalImpact: async (id) => {
      const impact = await ipcGenreRemovalImpact(id);
      return impact.tracks;
    },

    // Bulk add to all: append the genre to every member missing it, preserving each row's order.
    addAlbumGenre: (albumId, genreId) => {
      const membership = get().org.membership.map((r) =>
        r.album_id === albumId && !r.genre_ids.includes(genreId)
          ? { ...r, genre_ids: [...r.genre_ids, genreId] }
          : r,
      );
      mutateGenres(membership, () => ipcAddAlbumGenre(albumId, genreId));
    },

    // Bulk remove from all: drop the genre off every member that carries it.
    removeAlbumGenre: (albumId, genreId) => {
      const membership = get().org.membership.map((r) =>
        r.album_id === albumId && r.genre_ids.includes(genreId)
          ? { ...r, genre_ids: r.genre_ids.filter((id) => id !== genreId) }
          : r,
      );
      mutateGenres(membership, () => ipcRemoveAlbumGenre(albumId, genreId));
    },

    // Replaces one track's whole genre list, for the per-track editor.
    setTrackGenres: (trackId, genreIds) => {
      const membership = get().org.membership.map((r) =>
        r.track_id === trackId ? { ...r, genre_ids: genreIds } : r,
      );
      mutateGenres(membership, () => ipcSetTrackGenres(trackId, genreIds));
    },

    toggleSelect: (trackId) =>
      set((s) => {
        const selection = new Set(s.selection);
        if (!selection.delete(trackId)) selection.add(trackId);
        return { selection };
      }),

    selectOnly: (trackId) => set({ selection: new Set([trackId]) }),

    selectRange: (trackIds) => set({ selection: new Set(trackIds) }),

    // Union in, leaving selections held elsewhere untouched - a scoped select-all only adds its view.
    addSelection: (trackIds) =>
      set((s) => {
        const selection = new Set(s.selection);
        for (const id of trackIds) selection.add(id);
        return { selection };
      }),

    // Difference out, leaving selections held elsewhere untouched - a scoped clear only drops its view.
    removeSelection: (trackIds) =>
      set((s) => {
        const selection = new Set(s.selection);
        for (const id of trackIds) selection.delete(id);
        return { selection };
      }),

    clearSelection: () => set({ selection: new Set<number>() }),
  };
});

// Two album-field sets are equal when every editable column matches.
function sameAlbumFields(a: AlbumFields, b: AlbumFields): boolean {
  return (
    a.title === b.title &&
    a.album_artist === b.album_artist &&
    a.year === b.year &&
    a.genre === b.genre
  );
}

// Two override sets are equal when every override and numbering column matches.
function sameOverride(a: TrackOverride, b: TrackOverride): boolean {
  return (
    a.title_override === b.title_override &&
    a.artist_override === b.artist_override &&
    a.track_no === b.track_no &&
    a.disc_no === b.disc_no
  );
}

// Two orders are equal when they list the same ids in the same sequence.
function sameOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Two layouts are equal when every track lands on the same disc and per-disc position. Keyed by
// track_id, not position, so a pure re-sort with no real move is recognised as a no-op.
function sameLayout(a: TrackPlacement[], b: TrackPlacement[]): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((p) => [p.track_id, p]));
  return b.every((p) => {
    const prev = byId.get(p.track_id);
    return prev != null && prev.disc_no === p.disc_no && prev.track_no === p.track_no;
  });
}

// -- Selectors (narrow: each returns one primitive or one stable/shallow-stable reference) --

export const useAlbums = (): AlbumRow[] =>
  useOrganizeStore(useShallow((s) => s.org.albums.filter((a) => a.kind === "album")));

export const useSingles = (): AlbumRow[] =>
  useOrganizeStore(useShallow((s) => s.org.albums.filter((a) => a.kind === "single")));

export const useMembership = (): AlbumTrackRow[] =>
  useOrganizeStore(useShallow((s) => s.org.membership));

/**
 * The loose tracks: every scanned row with no album or single membership, in scan order. Reads the
 * shallow-stable tracks and membership references, then derives the filtered list with useMemo - the
 * fresh array each run would churn under useShallow alone, so the derivation hangs off stable inputs.
 * The Unsorted workspace reads this, and it shrinks as tracks are organized.
 */
export const useUnsortedTracks = (): TrackRow[] => {
  const tracks = useAppStore((s) => s.tracks);
  const membership = useOrganizeStore(useShallow((s) => s.org.membership));
  return useMemo(() => {
    const assigned = new Set(membership.map((r) => r.track_id));
    return tracks.filter((t) => !assigned.has(t.id));
  }, [tracks, membership]);
};

export const useGenres = (): GenreRow[] => useOrganizeStore(useShallow((s) => s.genres));

/** One pill of the album genre aggregate: a vocabulary genre, its member count, and whether all carry it. */
export interface GenreAggregateEntry {
  genre: GenreRow;
  count: number;
  onAll: boolean;
}

/**
 * The album's genre pills: the union of its members' genres, each with how many members carry it and
 * whether that is every member. Ordered by first appearance walking members in track order, so the row
 * holds steady as pills are added. `memberCount` feeds the "on k of n" partial text.
 */
export const useAlbumGenreAggregate = (
  albumId: number,
): { entries: GenreAggregateEntry[]; memberCount: number } => {
  // Select the raw inputs at shallow-stable identity, then derive the pills with useMemo. The
  // derivation builds a fresh nested `entries` array each run, which useShallow alone cannot stabilise
  // (its one-level compare always sees the new array and re-renders on a loop) - deriving off stable
  // inputs is what breaks that cycle.
  const members = useOrganizeStore(
    useShallow((s) => s.org.membership.filter((r) => r.album_id === albumId)),
  );
  const genres = useOrganizeStore(useShallow((s) => s.genres));
  return useMemo(() => {
    const ordered = [...members].sort((a, b) => (a.track_no ?? 0) - (b.track_no ?? 0));
    const byId = new Map(genres.map((g) => [g.id, g] as const));
    const counts = new Map<number, number>();
    const order: number[] = [];
    for (const row of ordered) {
      for (const id of row.genre_ids) {
        if (!counts.has(id)) order.push(id);
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    const entries: GenreAggregateEntry[] = [];
    for (const id of order) {
      const genre = byId.get(id);
      if (!genre) continue;
      const count = counts.get(id) ?? 0;
      entries.push({ genre, count, onAll: count === ordered.length });
    }
    return { entries, memberCount: ordered.length };
  }, [members, genres]);
};

/** One track's genres resolved to vocabulary rows, in stored position order. */
export const useTrackGenres = (trackId: number): GenreRow[] =>
  useOrganizeStore(
    useShallow((s) => {
      const row = s.org.membership.find((r) => r.track_id === trackId);
      if (!row) return [];
      const byId = new Map(s.genres.map((g) => [g.id, g] as const));
      return row.genre_ids
        .map((id) => byId.get(id))
        .filter((g): g is GenreRow => g !== undefined);
    }),
  );

export const useAlbumTracks = (albumId: number): AlbumTrackRow[] =>
  useOrganizeStore(
    useShallow((s) =>
      s.org.membership
        .filter((r) => r.album_id === albumId)
        .sort(
          (a, b) =>
            (a.disc_no ?? 1) - (b.disc_no ?? 1) || (a.track_no ?? 0) - (b.track_no ?? 0),
        ),
    ),
  );

export const useSelection = (): Set<number> => useOrganizeStore((s) => s.selection);
export const useCanUndo = (): boolean => useOrganizeStore((s) => s.past.length > 0);
export const useCanRedo = (): boolean => useOrganizeStore((s) => s.future.length > 0);
export const useOrgError = (): string | null => useOrganizeStore((s) => s.error);

export const useLoadOrganization = () => useOrganizeStore((s) => s.loadOrganization);
export const useLoadGenres = () => useOrganizeStore((s) => s.loadGenres);
export const useClearError = () => useOrganizeStore((s) => s.clearError);
export const useCommitAlbumFields = () => useOrganizeStore((s) => s.commitAlbumFields);
export const useCommitTrackOverrides = () => useOrganizeStore((s) => s.commitTrackOverrides);
export const useReorderTracks = () => useOrganizeStore((s) => s.reorderTracks);
export const useSetAlbumLayout = () => useOrganizeStore((s) => s.setAlbumLayout);
export const useAssignTracks = () => useOrganizeStore((s) => s.assignTracks);
export const useUnassignTracks = () => useOrganizeStore((s) => s.unassignTracks);
export const useUndo = () => useOrganizeStore((s) => s.undo);
export const useRedo = () => useOrganizeStore((s) => s.redo);
export const useCreateAlbum = () => useOrganizeStore((s) => s.createAlbum);
export const useCreateSingle = () => useOrganizeStore((s) => s.createSingle);
export const useDeleteAlbum = () => useOrganizeStore((s) => s.deleteAlbum);
export const useSetAlbumCover = () => useOrganizeStore((s) => s.setAlbumCover);
export const useCreateGenre = () => useOrganizeStore((s) => s.createGenre);
export const useRenameGenre = () => useOrganizeStore((s) => s.renameGenre);
export const useDeleteGenre = () => useOrganizeStore((s) => s.deleteGenre);
export const useMergeGenres = () => useOrganizeStore((s) => s.mergeGenres);
export const useGenreRemovalImpact = () => useOrganizeStore((s) => s.genreRemovalImpact);
export const useAddAlbumGenre = () => useOrganizeStore((s) => s.addAlbumGenre);
export const useRemoveAlbumGenre = () => useOrganizeStore((s) => s.removeAlbumGenre);
export const useSetTrackGenres = () => useOrganizeStore((s) => s.setTrackGenres);
export const useToggleSelect = () => useOrganizeStore((s) => s.toggleSelect);
export const useSelectOnly = () => useOrganizeStore((s) => s.selectOnly);
export const useSelectRange = () => useOrganizeStore((s) => s.selectRange);
export const useAddSelection = () => useOrganizeStore((s) => s.addSelection);
export const useRemoveSelection = () => useOrganizeStore((s) => s.removeSelection);
export const useClearSelection = () => useOrganizeStore((s) => s.clearSelection);
