/*
 * The playlists store: the flat playlist projection and every slot across all playlists, kept apart from
 * the organize/undo store so an album edit never touches playlist state. Structural writes follow
 * reload-on-write: fire the command, then reload so counts and positions stay true. Reorder is the one
 * optimistic path. The row identity everywhere is the slot `id`, never `track_id`: a playlist may hold
 * the same track twice, so a repeated track stays independently removable and reorderable.
 */

// -- Library Imports --
import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// -- IPC Imports --
import {
  addAlbumsToPlaylist as ipcAddAlbumsToPlaylist,
  addTracksToPlaylist as ipcAddTracksToPlaylist,
  createPlaylist as ipcCreatePlaylist,
  deletePlaylist as ipcDeletePlaylist,
  loadPlaylists as ipcLoadPlaylists,
  notReadyError,
  removePlaylistCover as ipcRemovePlaylistCover,
  removePlaylistSlots as ipcRemovePlaylistSlots,
  renamePlaylist as ipcRenamePlaylist,
  setPlaylistCover as ipcSetPlaylistCover,
  setPlaylistDescription as ipcSetPlaylistDescription,
  setPlaylistEntryKeepOrder as ipcSetPlaylistEntryKeepOrder,
  setPlaylistOrder as ipcSetPlaylistOrder,
  unpackPlaylistAlbumEntry as ipcUnpackPlaylistAlbumEntry,
} from "../../lib/ipc";

// -- State Imports --
// Imports the organize store, which imports this one back; each is read only inside actions.
import { useOrganizeStore } from "../organize/store";
import { createProjectionLoader } from "../projectionLoad";
import { reportLibraryChange } from "../plugins/libraryWatch";

// -- Type Imports --
import type { PlaylistAlbumEntryRow, PlaylistRow, PlaylistTrackRow } from "../../types";

interface PlaylistsStore {
  playlists: PlaylistRow[];
  tracks: PlaylistTrackRow[];
  // Album entries share the slot id space with `tracks`: both kinds order and reorder together.
  albumEntries: PlaylistAlbumEntryRow[];
  // True once a read has landed; `stalled` is true while the first read is outstanding past the threshold.
  ready: boolean;
  stalled: boolean;

  load: () => Promise<void>;
  create: (name: string | null) => Promise<number>;
  rename: (id: number, name: string | null) => Promise<void>;
  remove: (id: number) => Promise<void>;
  setDescription: (id: number, description: string | null) => Promise<void>;
  setCover: (id: number, srcPath: string) => Promise<void>;
  removeCover: (id: number) => Promise<void>;
  addTracks: (playlistId: number, trackIds: number[]) => Promise<void>;
  addAlbums: (playlistId: number, albumIds: number[], keepOrder: boolean) => Promise<void>;
  setKeepOrder: (slotId: number, keepOrder: boolean) => Promise<void>;
  unpack: (slotId: number) => Promise<void>;
  removeSlots: (slotIds: number[]) => Promise<void>;
  reorder: (playlistId: number, orderedSlotIds: number[]) => void;
}

export const usePlaylistsStore = create<PlaylistsStore>((set, get) => ({
  playlists: [],
  tracks: [],
  albumEntries: [],

  ready: false,
  stalled: false,

  // Before the first read lands this only starts it (or joins it) and returns at once. A later reload that
  // still fails keeps the rows already held; an error never reads as "no playlists".
  load: async () => {
    const landed = await playlistsLoader.load();
    if (!landed && playlistsLoader.isReady()) {
      console.warn("Playlists failed to load; keeping the current rows.");
    }
  },

  create: async (name) => {
    if (!writable()) throw notReadyError();
    const row = await ipcCreatePlaylist(name);
    await get().load();
    return row.id;
  },

  rename: async (id, name) => {
    if (!writable()) throw notReadyError();
    await ipcRenamePlaylist(id, name);
    await get().load();
  },

  remove: async (id) => {
    if (!writable()) throw notReadyError();
    await ipcDeletePlaylist(id);
    await get().load();
  },

  setDescription: async (id, description) => {
    if (!writable()) throw notReadyError();
    await ipcSetPlaylistDescription(id, description);
    await get().load();
  },

  // The picked path comes in from the field, which runs the picker at the call site the way the album
  // cover does; a null pick never reaches here. The bound cover's art is refreshed by the caller's hook.
  setCover: async (id, srcPath) => {
    if (!writable()) throw notReadyError();
    await ipcSetPlaylistCover(id, srcPath);
    await get().load();
  },

  removeCover: async (id) => {
    if (!writable()) throw notReadyError();
    await ipcRemovePlaylistCover(id);
    await get().load();
  },

  addTracks: async (playlistId, trackIds) => {
    if (!writable()) throw notReadyError();
    await ipcAddTracksToPlaylist(playlistId, trackIds);
    await get().load();
  },

  addAlbums: async (playlistId, albumIds, keepOrder) => {
    if (!writable(true)) throw notReadyError();
    await ipcAddAlbumsToPlaylist(playlistId, albumIds, keepOrder);
    await get().load();
  },

  setKeepOrder: async (slotId, keepOrder) => {
    if (!writable()) throw notReadyError();
    await ipcSetPlaylistEntryKeepOrder(slotId, keepOrder);
    await get().load();
  },

  unpack: async (slotId) => {
    if (!writable()) throw notReadyError();
    await ipcUnpackPlaylistAlbumEntry(slotId);
    await get().load();
  },

  removeSlots: async (slotIds) => {
    if (!writable()) throw notReadyError();
    await ipcRemovePlaylistSlots(slotIds);
    await get().load();
  },

  // Optimistic: renumber this playlist's slots to the new order at once, then persist. A drag settles
  // with no reload flicker; a failed write reloads from truth to drop the optimistic order.
  reorder: (playlistId, orderedSlotIds) => {
    if (!writable()) return;
    const position = new Map(orderedSlotIds.map((id, i) => [id, i + 1]));
    const renumber = <T extends { id: number; playlist_id: number; position: number }>(
      rows: T[],
    ): T[] =>
      rows.map((row) =>
        row.playlist_id === playlistId && position.has(row.id)
          ? { ...row, position: position.get(row.id) ?? row.position }
          : row,
      );
    set((s) => ({ tracks: renumber(s.tracks), albumEntries: renumber(s.albumEntries) }));
    ipcSetPlaylistOrder(playlistId, orderedSlotIds).then(
      () => reportLibraryChange({ track_ids: [], albums: false, playlists: true }),
      () => {
        void get().load();
      },
    );
  },
}));

/**
 * The write gate: a playlist write before the playlists have loaded would act on rows that only look
 * empty. A write that reads album membership also waits for the albums. Reads the live flags.
 */
function writable(withAlbums = false): boolean {
  return usePlaylistsStore.getState().ready && (!withAlbums || useOrganizeStore.getState().orgReady);
}

/** The playlists read: `boot()` starts it, and every later load joins or follows it. */
export const playlistsLoader = createProjectionLoader({
  name: "playlists",
  read: () => ipcLoadPlaylists(),
  apply: (snapshot) =>
    usePlaylistsStore.setState({
      playlists: snapshot.playlists,
      tracks: snapshot.tracks,
      albumEntries: snapshot.album_entries,
    }),
  onFlags: ({ ready, stalled }) => usePlaylistsStore.setState({ ready, stalled }),
});

// -- Selectors (narrow: each returns one primitive or one shallow-stable reference) --

export const usePlaylists = (): PlaylistRow[] =>
  usePlaylistsStore(useShallow((s) => s.playlists));

/** One playlist by id, or undefined when it is gone. */
export const usePlaylist = (id: number): PlaylistRow | undefined =>
  usePlaylistsStore((s) => s.playlists.find((p) => p.id === id));

/**
 * One playlist's slots, sorted by position. Reads the shallow-stable tracks reference, then derives the
 * filtered/sorted list with useMemo - a fresh array each run would churn under useShallow, so the
 * derivation hangs off the stable input, mirroring the organize store's album-track selector.
 */
export const usePlaylistTracks = (playlistId: number): PlaylistTrackRow[] => {
  const tracks = usePlaylistsStore(useShallow((s) => s.tracks));
  return useMemo(
    () =>
      tracks
        .filter((slot) => slot.playlist_id === playlistId)
        .sort((a, b) => a.position - b.position),
    [tracks, playlistId],
  );
};

/** One playlist's album entries, sorted by position then slot id. */
export const usePlaylistAlbumEntries = (playlistId: number): PlaylistAlbumEntryRow[] => {
  const entries = usePlaylistsStore(useShallow((s) => s.albumEntries));
  return useMemo(
    () =>
      entries
        .filter((entry) => entry.playlist_id === playlistId)
        .sort((a, b) => a.position - b.position || a.id - b.id),
    [entries, playlistId],
  );
};

export const useLoadPlaylists = () =>usePlaylistsStore((s) => s.load);
export const useCreatePlaylist = () => usePlaylistsStore((s) => s.create);
export const useRenamePlaylist = () => usePlaylistsStore((s) => s.rename);
export const useRemovePlaylist = () => usePlaylistsStore((s) => s.remove);
export const useSetPlaylistDescription = () => usePlaylistsStore((s) => s.setDescription);
export const useSetPlaylistCover = () => usePlaylistsStore((s) => s.setCover);
export const useRemovePlaylistCover = () => usePlaylistsStore((s) => s.removeCover);
export const useAddTracksToPlaylist = () => usePlaylistsStore((s) => s.addTracks);
export const useAddAlbumsToPlaylist = () => usePlaylistsStore((s) => s.addAlbums);
export const useSetEntryKeepOrder = () => usePlaylistsStore((s) => s.setKeepOrder);
export const useUnpackAlbumEntry = () => usePlaylistsStore((s) => s.unpack);
export const useRemovePlaylistSlots = () => usePlaylistsStore((s) => s.removeSlots);
export const useReorderPlaylist = () => usePlaylistsStore((s) => s.reorder);
