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
  usePlaylistsStore.setState({ playlists: [], tracks: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("playlists store load", () => {
  it("keeps the earlier playlists when the read keeps rejecting", async () => {
    loadPlaylists.mockResolvedValueOnce({ playlists: [row(1)], tracks: [slot(5, 1)] });
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
      .mockResolvedValue({ playlists: [row(2)], tracks: [] });
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
    loadPlaylists.mockResolvedValue({ playlists: [], tracks: [] });
    await usePlaylistsStore.getState().load();
    expect(usePlaylistsStore.getState().playlists).toEqual([]);
  });
});
