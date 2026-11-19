// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- State Imports --
import { orgLoader, useOrganizeStore } from "./store";
import { playlistsLoader, usePlaylistsStore } from "../playlists/store";
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
    takePointBefore: vi.fn(),
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
  orgLoader.reset();
  playlistsLoader.reset();
  useOrganizeStore.setState({ past: [], future: [] });
  usePlaylistsStore.setState({ playlists: [], tracks: [], albumEntries: [] });
  loadOrganization.mockResolvedValue(snapshot);
  loadPlaylists.mockResolvedValue({ playlists: [], tracks: [], album_entries: [entry] });
  deleteAlbum.mockResolvedValue(undefined);
  vi.mocked(ipc.takePointBefore).mockResolvedValue(true);
});

afterEach(() => {
  orgLoader.reset();
  playlistsLoader.reset();
  vi.useRealTimers();
});

describe("orgReady", () => {
  it("starts false and turns true once the projection loads", async () => {
    expect(useOrganizeStore.getState().orgReady).toBe(false);
    await orgLoader.start();
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("retries an early rejection and ends ready", async () => {
    loadOrganization.mockRejectedValueOnce(new Error("early")).mockResolvedValue(snapshot);
    await settle(orgLoader.start());
    expect(loadOrganization).toHaveBeenCalledTimes(2);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("keeps a loaded projection and the ready flag when a later reload keeps failing", async () => {
    const albums = [{ id: 4 }] as never;
    loadOrganization.mockResolvedValueOnce({ albums, membership: [], genres: [] });
    await orgLoader.start();
    loadOrganization.mockRejectedValue(new Error("down"));
    await settle(useOrganizeStore.getState().loadOrganization());
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    expect(useOrganizeStore.getState().org.albums).toBe(albums);
  });

  it("stays not ready, with nothing applied, while the first read keeps failing", async () => {
    const applied = vi.fn();
    const unsubscribe = useOrganizeStore.subscribe((s, prev) => {
      if (s.org !== prev.org) applied();
    });
    loadOrganization.mockRejectedValue(new Error("down"));
    void orgLoader.start();
    await vi.advanceTimersByTimeAsync(120_000);
    unsubscribe();
    expect(useOrganizeStore.getState().orgReady).toBe(false);
    expect(applied).not.toHaveBeenCalled();
    expect(loadOrganization.mock.calls.length).toBeGreaterThan(12);
  });

  it("lands after twenty rejections", async () => {
    for (let i = 0; i < 20; i++) loadOrganization.mockRejectedValueOnce(new Error("early"));
    void orgLoader.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadOrganization).toHaveBeenCalledTimes(21);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("recovers when the first read never settles", async () => {
    loadOrganization.mockReturnValueOnce(new Promise(() => {}));
    void orgLoader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("flags stalled at ten seconds and clears it on landing", async () => {
    let answer: (v: typeof snapshot) => void = () => {};
    loadOrganization
      .mockReturnValueOnce(new Promise((r) => (answer = r)))
      .mockReturnValue(new Promise(() => {}));
    void orgLoader.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(useOrganizeStore.getState().orgStalled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(useOrganizeStore.getState().orgStalled).toBe(true);
    expect(useOrganizeStore.getState().orgReady).toBe(false);
    answer(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(useOrganizeStore.getState().orgStalled).toBe(false);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("drops a late answer once a newer read applied", async () => {
    const stale = { albums: [{ id: 1 }], membership: [], genres: [] } as never;
    let answer: (v: typeof snapshot) => void = () => {};
    loadOrganization.mockReturnValueOnce(new Promise((r) => (answer = r)));
    void orgLoader.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    answer(stale);
    await vi.advanceTimersByTimeAsync(0);
    expect(useOrganizeStore.getState().org.albums).toEqual([]);
  });

  it("wakes a waiting read on a window focus", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    loadOrganization.mockRejectedValueOnce(new Error("early"));
    void orgLoader.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(loadOrganization).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    vi.unstubAllGlobals();
  });

  it("returns at once from a load and a refresh while the first read is stuck", async () => {
    loadOrganization.mockReturnValue(new Promise(() => {}));
    void orgLoader.start();
    await useOrganizeStore.getState().loadOrganization();
    expect(await useOrganizeStore.getState().refreshOrganization()).toBe(false);
    expect(useOrganizeStore.getState().orgReady).toBe(false);
  });

  it("reloads once more after the first read lands when a reload was asked for meanwhile", async () => {
    let answer: (v: typeof snapshot) => void = () => {};
    loadOrganization.mockReturnValueOnce(new Promise((r) => (answer = r))).mockResolvedValue(snapshot);
    void orgLoader.start();
    await useOrganizeStore.getState().loadOrganization();
    expect(loadOrganization).toHaveBeenCalledTimes(1);
    answer(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(loadOrganization).toHaveBeenCalledTimes(2);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("lets a failed save reload never empty a loaded projection", async () => {
    const albums = [{ id: 4 }] as never;
    loadOrganization.mockResolvedValueOnce({ albums, membership: [], genres: [] });
    await orgLoader.start();
    loadOrganization.mockRejectedValue(new Error("down"));
    useOrganizeStore.getState().clearError();
    void orgLoader.reload();
    await vi.runAllTimersAsync();
    expect(useOrganizeStore.getState().org.albums).toBe(albums);
  });

  it("keeps the ready flag through a refresh that fails", async () => {
    await orgLoader.start();
    loadOrganization.mockRejectedValue(new Error("down"));
    expect(await useOrganizeStore.getState().refreshOrganization()).toBe(false);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });
});

// Both projections already loaded, with the call counts cleared: the writes below reload loaded stores.
async function bothReady(): Promise<void> {
  await orgLoader.start();
  await playlistsLoader.start();
  loadOrganization.mockClear();
  loadPlaylists.mockClear();
}

describe("tag batch undo and redo", () => {
  beforeEach(bothReady);

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
  beforeEach(bothReady);

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

  it("saves a restore point before deleting more than one album", async () => {
    await useOrganizeStore.getState().deleteAlbums([4, 5]);
    expect(ipc.takePointBefore).toHaveBeenCalledWith("delete_albums");
    expect(vi.mocked(ipc.takePointBefore).mock.invocationCallOrder[0]).toBeLessThan(
      deleteAlbum.mock.invocationCallOrder[0],
    );
  });

  it("deletes nothing when a restore began while the point was saved", async () => {
    vi.mocked(ipc.takePointBefore).mockImplementation(async () => {
      orgLoader.hold();
      return true;
    });
    try {
      await expect(useOrganizeStore.getState().deleteAlbums([4, 5])).rejects.toSatisfy(ipc.isNotReady);
      expect(deleteAlbum).not.toHaveBeenCalled();
    } finally {
      orgLoader.release();
    }
  });

  it("saves no point for a single album", async () => {
    await useOrganizeStore.getState().deleteAlbums([4]);
    await useOrganizeStore.getState().deleteAlbum(4);
    expect(ipc.takePointBefore).not.toHaveBeenCalled();
  });

  it("deletes anyway when the point could not be saved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(ipc.takePointBefore).mockRejectedValue(new Error("disk full"));
    await useOrganizeStore.getState().deleteAlbums([4, 5]);
    expect(deleteAlbum).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
