/*
 * The playlists store: the flat playlist projection and every slot across all playlists, kept apart
 * from the organize/undo store so an album edit never touches playlist state. Structural writes
 * (create, rename, delete, add, remove) follow reload-on-write, the shape the genre vocabulary uses:
 * fire the command, then reload from the backend so the counts and positions stay true. Reorder is the
 * one optimistic path - it renumbers the local slots at once so a drag never flickers, and reloads only
 * when the persist fails. The row identity everywhere is the slot `id`, never `track_id`: a playlist may
 * hold the same track more than once, so a repeated track stays independently removable and reorderable.
 */

// -- Library Imports --
import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// -- IPC Imports --
import {
  addTracksToPlaylist as ipcAddTracksToPlaylist,
  createPlaylist as ipcCreatePlaylist,
  deletePlaylist as ipcDeletePlaylist,
  loadPlaylists as ipcLoadPlaylists,
  removePlaylistCover as ipcRemovePlaylistCover,
  removePlaylistSlots as ipcRemovePlaylistSlots,
  renamePlaylist as ipcRenamePlaylist,
  setPlaylistCover as ipcSetPlaylistCover,
  setPlaylistDescription as ipcSetPlaylistDescription,
  setPlaylistOrder as ipcSetPlaylistOrder,
} from "../../lib/ipc";

// -- Type Imports --
import type { PlaylistRow, PlaylistTrackRow } from "../../types";

interface PlaylistsStore {
  playlists: PlaylistRow[];
  tracks: PlaylistTrackRow[];

  load: () => Promise<void>;
  create: (name: string | null) => Promise<number>;
  rename: (id: number, name: string | null) => Promise<void>;
  remove: (id: number) => Promise<void>;
  setDescription: (id: number, description: string | null) => Promise<void>;
  setCover: (id: number, srcPath: string) => Promise<void>;
  removeCover: (id: number) => Promise<void>;
  addTracks: (playlistId: number, trackIds: number[]) => Promise<void>;
  removeSlots: (slotIds: number[]) => Promise<void>;
  reorder: (playlistId: number, orderedSlotIds: number[]) => void;
}

export const usePlaylistsStore = create<PlaylistsStore>((set, get) => ({
  playlists: [],
  tracks: [],

  load: async () => {
    try {
      const snapshot = await ipcLoadPlaylists();
      set({ playlists: snapshot.playlists, tracks: snapshot.tracks });
    } catch {
      set({ playlists: [], tracks: [] });
    }
  },

  create: async (name) => {
    const row = await ipcCreatePlaylist(name);
    await get().load();
    return row.id;
  },

  rename: async (id, name) => {
    await ipcRenamePlaylist(id, name);
    await get().load();
  },

  remove: async (id) => {
    await ipcDeletePlaylist(id);
    await get().load();
  },

  setDescription: async (id, description) => {
    await ipcSetPlaylistDescription(id, description);
    await get().load();
  },

  // The picked path comes in from the field, which runs the picker at the call site the way the album
  // cover does; a null pick never reaches here. The bound cover's art is refreshed by the caller's hook.
  setCover: async (id, srcPath) => {
    await ipcSetPlaylistCover(id, srcPath);
    await get().load();
  },

  removeCover: async (id) => {
    await ipcRemovePlaylistCover(id);
    await get().load();
  },

  addTracks: async (playlistId, trackIds) => {
    await ipcAddTracksToPlaylist(playlistId, trackIds);
    await get().load();
  },

  removeSlots: async (slotIds) => {
    await ipcRemovePlaylistSlots(slotIds);
    await get().load();
  },

  // Optimistic: renumber this playlist's slots to the new order at once, then persist. A drag settles
  // with no reload flicker; a failed write reloads from truth to drop the optimistic order.
  reorder: (playlistId, orderedSlotIds) => {
    const position = new Map(orderedSlotIds.map((id, i) => [id, i + 1]));
    set((s) => ({
      tracks: s.tracks.map((slot) =>
        slot.playlist_id === playlistId && position.has(slot.id)
          ? { ...slot, position: position.get(slot.id) ?? slot.position }
          : slot,
      ),
    }));
    void ipcSetPlaylistOrder(playlistId, orderedSlotIds).catch(() => {
      void get().load();
    });
  },
}));

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

export const useLoadPlaylists = () => usePlaylistsStore((s) => s.load);
export const useCreatePlaylist = () => usePlaylistsStore((s) => s.create);
export const useRenamePlaylist = () => usePlaylistsStore((s) => s.rename);
export const useRemovePlaylist = () => usePlaylistsStore((s) => s.remove);
export const useSetPlaylistDescription = () => usePlaylistsStore((s) => s.setDescription);
export const useSetPlaylistCover = () => usePlaylistsStore((s) => s.setCover);
export const useRemovePlaylistCover = () => usePlaylistsStore((s) => s.removeCover);
export const useAddTracksToPlaylist = () => usePlaylistsStore((s) => s.addTracks);
export const useRemovePlaylistSlots = () => usePlaylistsStore((s) => s.removeSlots);
export const useReorderPlaylist = () => usePlaylistsStore((s) => s.reorder);
