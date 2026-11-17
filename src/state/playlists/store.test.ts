// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- State Imports --
import { usePlaylistsStore } from "./store";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

// -- Type Imports --
import type { PlaylistRow, PlaylistTrackRow } from "../../types";

vi.mock("../../lib/ipc", async (original) => {
  const real = await original<typeof import("../../lib/ipc")>();
  return { ...real, loadPlaylists: vi.fn(), createPlaylist: vi.fn() };
});

const loadPlaylists = vi.mocked(ipc.loadPlaylists);
const createPlaylist = vi.mocked(ipc.createPlaylist);

const row = (id: number) => ({ id, name: `p${id}` }) as PlaylistRow;
const slot = (id: number, playlist_id: number) => ({ id, playlist_id, position: 1 }) as PlaylistTrackRow;

// Runs `work` while the retry backoff elapses on fake timers.
async function settle<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  usePlaylistsStore.setState({ playlists: [], tracks: [], albumEntries: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("playlists store load", () => {
  it("keeps the earlier playlists when the read keeps rejecting", async () => {
    loadPlaylists.mockResolvedValueOnce({ playlists: [row(1)], tracks: [slot(5, 1)], album_entries: [] });
    await usePlaylistsStore.getState().load();
    loadPlaylists.mockRejectedValue(new Error("not ready"));
    await settle(usePlaylistsStore.getState().load());
    expect(usePlaylistsStore.getState().playlists).toEqual([row(1)]);
    expect(usePlaylistsStore.getState().tracks).toEqual([slot(5, 1)]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("ends with the loaded rows when the read fails twice and then succeeds", async () => {
    loadPlaylists
      .mockRejectedValueOnce(new Error("early"))
      .mockRejectedValueOnce(new Error("early"))
      .mockResolvedValue({ playlists: [row(2)], tracks: [], album_entries: [] });
    await settle(usePlaylistsStore.getState().load());
    expect(loadPlaylists).toHaveBeenCalledTimes(3);
    expect(usePlaylistsStore.getState().playlists).toEqual([row(2)]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps the list when the reload after a create fails", async () => {
    usePlaylistsStore.setState({ playlists: [row(1)], tracks: [slot(5, 1)] });
    createPlaylist.mockResolvedValue(row(2));
    loadPlaylists.mockRejectedValue(new Error("down"));
    const id = await settle(usePlaylistsStore.getState().create("two"));
    expect(id).toBe(2);
    expect(usePlaylistsStore.getState().playlists).toEqual([row(1)]);
    expect(usePlaylistsStore.getState().tracks).toEqual([slot(5, 1)]);
  });

  it("still shows a genuinely empty read as empty", async () => {
    usePlaylistsStore.setState({ playlists: [row(1)] });
    loadPlaylists.mockResolvedValue({ playlists: [], tracks: [], album_entries: [] });
    await usePlaylistsStore.getState().load();
    expect(usePlaylistsStore.getState().playlists).toEqual([]);
  });

  it("keeps the album entries the read carried", async () => {
    const entry = { id: 9, playlist_id: 1, album_id: 4, position: 2, keep_order: true };
    loadPlaylists.mockResolvedValue({ playlists: [row(1)], tracks: [], album_entries: [entry] });
    await usePlaylistsStore.getState().load();
    expect(usePlaylistsStore.getState().albumEntries).toEqual([entry]);
  });
});

describe("playlists store album entry writes", () => {
  const entry = { id: 9, playlist_id: 1, album_id: 4, position: 2, keep_order: true };

  it("renumbers an album entry with the track slots on reorder", () => {
    usePlaylistsStore.setState({
      playlists: [row(1)],
      tracks: [slot(5, 1)],
      albumEntries: [entry],
    });
    vi.spyOn(ipc, "setPlaylistOrder").mockResolvedValue(undefined);
    usePlaylistsStore.getState().reorder(1, [9, 5]);
    expect(usePlaylistsStore.getState().albumEntries[0].position).toBe(1);
    expect(usePlaylistsStore.getState().tracks[0].position).toBe(2);
  });

  it("reloads after adding albums", async () => {
    const add = vi.spyOn(ipc, "addAlbumsToPlaylist").mockResolvedValue(undefined);
    loadPlaylists.mockResolvedValue({ playlists: [row(1)], tracks: [], album_entries: [entry] });
    await usePlaylistsStore.getState().addAlbums(1, [4], true);
    expect(add).toHaveBeenCalledWith(1, [4], true);
    expect(usePlaylistsStore.getState().albumEntries).toEqual([entry]);
  });
});
