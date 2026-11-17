// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- State Imports --
import { useOrganizeStore } from "./store";
import { usePlaylistsStore } from "../playlists/store";
import { reportLibraryChange } from "../plugins/libraryWatch";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

vi.mock("../../lib/ipc", async (original) => {
  const real = await original<typeof import("../../lib/ipc")>();
  return {
    ...real,
    loadOrganization: vi.fn(),
    deleteAlbum: vi.fn(),
    loadPlaylists: vi.fn(),
    revertAlbumsFromTags: vi.fn(),
    reapplyAlbumsFromTags: vi.fn(),
  };
});
vi.mock("../plugins/libraryWatch", async (original) => {
  const real = await original<typeof import("../plugins/libraryWatch")>();
  return { ...real, reportLibraryChange: vi.fn() };
});

const loadOrganization = vi.mocked(ipc.loadOrganization);
const deleteAlbum = vi.mocked(ipc.deleteAlbum);
const loadPlaylists = vi.mocked(ipc.loadPlaylists);

const snapshot = { albums: [], membership: [], genres: [] };
const entry = { id: 9, playlist_id: 1, album_id: 4, position: 1, keep_order: true };

// Runs `work` while the retry backoff elapses on fake timers.
async function settle<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useOrganizeStore.setState({ orgReady: false, past: [], future: [] });
  usePlaylistsStore.setState({ playlists: [], tracks: [], albumEntries: [] });
  loadOrganization.mockResolvedValue(snapshot);
  loadPlaylists.mockResolvedValue({ playlists: [], tracks: [], album_entries: [entry] });
  deleteAlbum.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("orgReady", () => {
  it("starts false and turns true once the projection loads", async () => {
    expect(useOrganizeStore.getState().orgReady).toBe(false);
    await useOrganizeStore.getState().loadOrganization();
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("retries an early rejection and ends ready", async () => {
    loadOrganization.mockRejectedValueOnce(new Error("early")).mockResolvedValue(snapshot);
    await settle(useOrganizeStore.getState().loadOrganization());
    expect(loadOrganization).toHaveBeenCalledTimes(2);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("keeps a loaded projection and the ready flag when a later reload keeps failing", async () => {
    const albums = [{ id: 4 }] as never;
    loadOrganization.mockResolvedValueOnce({ albums, membership: [], genres: [] });
    await useOrganizeStore.getState().loadOrganization();
    loadOrganization.mockRejectedValue(new Error("down"));
    await settle(useOrganizeStore.getState().loadOrganization());
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    expect(useOrganizeStore.getState().org.albums).toBe(albums);
  });

  it("leaves the first load not ready and empty when it keeps failing", async () => {
    loadOrganization.mockRejectedValue(new Error("down"));
    await settle(useOrganizeStore.getState().loadOrganization());
    expect(useOrganizeStore.getState().orgReady).toBe(false);
    expect(useOrganizeStore.getState().org.albums).toEqual([]);
  });

  it("keeps the ready flag through a refresh that fails", async () => {
    await useOrganizeStore.getState().loadOrganization();
    loadOrganization.mockRejectedValue(new Error("down"));
    expect(await useOrganizeStore.getState().refreshOrganization()).toBe(false);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });
});

describe("tag batch undo and redo", () => {
  const receipt = { created: [], extended: [] };

  it("reloads the playlists before the projection and reports them on a revert", async () => {
    vi.mocked(ipc.revertAlbumsFromTags).mockResolvedValue(undefined);
    useOrganizeStore.setState({ past: [{ kind: "tagBatch", receipt, applied: true }], future: [] });
    useOrganizeStore.getState().undo();
    await vi.runAllTimersAsync();
    expect(ipc.revertAlbumsFromTags).toHaveBeenCalledWith(receipt);
    expect(loadPlaylists).toHaveBeenCalledTimes(1);
    expect(loadPlaylists.mock.invocationCallOrder[0]).toBeLessThan(
      loadOrganization.mock.invocationCallOrder[0],
    );
    expect(reportLibraryChange).toHaveBeenCalledWith({ track_ids: [], albums: false, playlists: true });
  });

  it("leaves the playlists alone on a redo, which dissolves nothing", async () => {
    vi.mocked(ipc.reapplyAlbumsFromTags).mockResolvedValue(undefined);
    useOrganizeStore.setState({
      past: [],
      future: [{ kind: "tagBatch", receipt, applied: true }],
    });
    useOrganizeStore.getState().redo();
    await vi.runAllTimersAsync();
    expect(ipc.reapplyAlbumsFromTags).toHaveBeenCalledWith(receipt);
    expect(loadPlaylists).not.toHaveBeenCalled();
  });
});

describe("album delete", () => {
  it("reloads the playlists and reports them changed", async () => {
    await useOrganizeStore.getState().deleteAlbum(4);
    expect(loadPlaylists).toHaveBeenCalledTimes(1);
    expect(usePlaylistsStore.getState().albumEntries).toEqual([entry]);
    expect(reportLibraryChange).toHaveBeenCalledWith({ track_ids: [], albums: false, playlists: true });
  });

  it("reloads the playlists before the projection", async () => {
    await useOrganizeStore.getState().deleteAlbum(4);
    expect(loadPlaylists.mock.invocationCallOrder[0]).toBeLessThan(
      loadOrganization.mock.invocationCallOrder[0],
    );
  });

  it("does the same once for a bulk delete, even when one removal fails", async () => {
    deleteAlbum.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("gone"));
    await useOrganizeStore.getState().deleteAlbums([4, 5, 6]);
    expect(loadPlaylists).toHaveBeenCalledTimes(1);
    expect(reportLibraryChange).toHaveBeenCalledWith({ track_ids: [], albums: false, playlists: true });
  });
});
