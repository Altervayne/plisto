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
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// -- State Imports --
import { useAppStore } from "../store";

// -- Engine Imports --
import { applyCommand, commandToIpc, invertCommand } from "./orgCommands";

// -- IPC Imports --
import {
  createAlbum as ipcCreateAlbum,
  deleteAlbum as ipcDeleteAlbum,
  loadOrganization as ipcLoadOrganization,
  setAlbumCover as ipcSetAlbumCover,
} from "../../lib/ipc";

// -- Type Imports --
import type { AlbumFields, AlbumRow, AlbumTrackRow, TrackOverride } from "../../types";
import type { Command, OrgState, Placement } from "./orgCommands";

interface OrganizeStore {
  org: OrgState;
  past: Command[];
  future: Command[];
  selection: Set<number>;
  error: string | null;

  loadOrganization: () => Promise<void>;
  clearError: () => void;

  commitAlbumFields: (albumId: number, next: AlbumFields) => void;
  commitTrackOverrides: (albumId: number, trackId: number, next: TrackOverride) => void;
  reorderTracks: (albumId: number, nextOrder: number[]) => void;
  assignTracks: (albumId: number, trackIds: number[]) => void;
  unassignTracks: (albumId: number, trackIds: number[]) => void;

  undo: () => void;
  redo: () => void;

  createAlbum: (fields: AlbumFields, trackIds: number[]) => Promise<number>;
  deleteAlbum: (albumId: number) => Promise<void>;
  setAlbumCover: (albumId: number, srcPath: string) => Promise<void>;

  toggleSelect: (trackId: number) => void;
  selectOnly: (trackId: number) => void;
  selectRange: (trackIds: number[]) => void;
  addSelection: (trackIds: number[]) => void;
  removeSelection: (trackIds: number[]) => void;
  clearSelection: () => void;
}

const emptyOrg: OrgState = { albums: [], membership: [] };

export const useOrganizeStore = create<OrganizeStore>((set, get) => {
  // Fires a command's write, and on a failed persist resyncs from the DB (the optimistic projection is
  // now ahead of it) and surfaces a quiet error. The whole stack is not reverted - a reload is the
  // correct recovery, leaving past/future intact.
  const persist = (cmd: Command): void => {
    void commandToIpc(cmd).catch(() => {
      void get().loadOrganization();
      set({ error: "A change could not be saved. Reloaded from the library." });
    });
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
    };
  };

  return {
    org: emptyOrg,
    past: [],
    future: [],
    selection: new Set<number>(),
    error: null,

    loadOrganization: async () => {
      try {
        const snapshot = await ipcLoadOrganization();
        set({ org: { albums: snapshot.albums, membership: snapshot.membership } });
      } catch {
        set({ org: emptyOrg });
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

// -- Selectors (narrow: each returns one primitive or one stable/shallow-stable reference) --

export const useAlbums = (): AlbumRow[] => useOrganizeStore((s) => s.org.albums);

export const useAlbumTracks = (albumId: number): AlbumTrackRow[] =>
  useOrganizeStore(
    useShallow((s) =>
      s.org.membership
        .filter((r) => r.album_id === albumId)
        .sort((a, b) => (a.track_no ?? 0) - (b.track_no ?? 0)),
    ),
  );

export const useSelection = (): Set<number> => useOrganizeStore((s) => s.selection);
export const useCanUndo = (): boolean => useOrganizeStore((s) => s.past.length > 0);
export const useCanRedo = (): boolean => useOrganizeStore((s) => s.future.length > 0);
export const useOrgError = (): string | null => useOrganizeStore((s) => s.error);

export const useLoadOrganization = () => useOrganizeStore((s) => s.loadOrganization);
export const useClearError = () => useOrganizeStore((s) => s.clearError);
export const useCommitAlbumFields = () => useOrganizeStore((s) => s.commitAlbumFields);
export const useCommitTrackOverrides = () => useOrganizeStore((s) => s.commitTrackOverrides);
export const useReorderTracks = () => useOrganizeStore((s) => s.reorderTracks);
export const useAssignTracks = () => useOrganizeStore((s) => s.assignTracks);
export const useUnassignTracks = () => useOrganizeStore((s) => s.unassignTracks);
export const useUndo = () => useOrganizeStore((s) => s.undo);
export const useRedo = () => useOrganizeStore((s) => s.redo);
export const useCreateAlbum = () => useOrganizeStore((s) => s.createAlbum);
export const useDeleteAlbum = () => useOrganizeStore((s) => s.deleteAlbum);
export const useSetAlbumCover = () => useOrganizeStore((s) => s.setAlbumCover);
export const useToggleSelect = () => useOrganizeStore((s) => s.toggleSelect);
export const useSelectOnly = () => useOrganizeStore((s) => s.selectOnly);
export const useSelectRange = () => useOrganizeStore((s) => s.selectRange);
export const useAddSelection = () => useOrganizeStore((s) => s.addSelection);
export const useRemoveSelection = () => useOrganizeStore((s) => s.removeSelection);
export const useClearSelection = () => useOrganizeStore((s) => s.clearSelection);
