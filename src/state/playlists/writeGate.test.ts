// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- State Imports --
import { orgLoader } from "../organize/store";
import { playlistsLoader, usePlaylistsStore } from "./store";

// -- IPC Imports --
import { isNotReady } from "../../lib/ipc";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {},
  convertFileSrc: (path: string) => path,
}));
vi.mock("../plugins/libraryWatch", async (original) => {
  const real = await original<typeof import("../plugins/libraryWatch")>();
  return { ...real, reportLibraryChange: vi.fn() };
});

type Store = ReturnType<typeof usePlaylistsStore.getState>;

/** The one method that reads: everything else on the store writes playlists. */
const NOT_WRITES = ["load"];

/** The writes, each with the loaders it needs. */
const WRITES: Record<string, { needsAlbums: boolean; call: (s: Store) => unknown }> = {
  create: { needsAlbums: false, call: (s) => s.create("p") },
  rename: { needsAlbums: false, call: (s) => s.rename(1, "p") },
  remove: { needsAlbums: false, call: (s) => s.remove(1) },
  setDescription: { needsAlbums: false, call: (s) => s.setDescription(1, "d") },
  setCover: { needsAlbums: false, call: (s) => s.setCover(1, "a.png") },
  removeCover: { needsAlbums: false, call: (s) => s.removeCover(1) },
  addTracks: { needsAlbums: false, call: (s) => s.addTracks(1, [2]) },
  addAlbums: { needsAlbums: true, call: (s) => s.addAlbums(1, [4], true) },
  setKeepOrder: { needsAlbums: false, call: (s) => s.setKeepOrder(9, false) },
  unpack: { needsAlbums: false, call: (s) => s.unpack(9) },
  removeSlots: { needsAlbums: false, call: (s) => s.removeSlots([5]) },
  reorder: { needsAlbums: false, call: (s) => s.reorder(1, [6, 5]) },
};

const slot = (id: number, position: number) => ({ id, playlist_id: 1, position });
const snapshot = { playlists: [], tracks: [slot(5, 1), slot(6, 2)], album_entries: [] };

const writeCalls = () =>
  invoke.mock.calls.filter(([cmd]) => cmd !== "load_organization" && cmd !== "load_playlists");

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_organization") return { albums: [], membership: [], genres: [] };
    if (cmd === "load_playlists") return snapshot;
    return { id: 1 };
  });
  orgLoader.reset();
  playlistsLoader.reset();
  usePlaylistsStore.setState({ playlists: [], tracks: [slot(5, 1), slot(6, 2)] as never, albumEntries: [] });
});

afterEach(() => {
  orgLoader.reset();
  playlistsLoader.reset();
});

describe("playlists write gate", () => {
  it("covers every function the store exposes", () => {
    const functions = Object.entries(usePlaylistsStore.getState())
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .filter((key) => !NOT_WRITES.includes(key));
    expect(functions.sort()).toEqual(Object.keys(WRITES).sort());
  });

  describe.each(Object.keys(WRITES))("%s", (name) => {
    it("is refused while the playlists have not loaded", async () => {
      const before = usePlaylistsStore.getState();
      const outcome = await Promise.resolve(WRITES[name].call(before)).then(
        () => null,
        (e: unknown) => e,
      );
      if (outcome !== null) expect(isNotReady(outcome)).toBe(true);
      expect(writeCalls()).toEqual([]);
      expect(usePlaylistsStore.getState().tracks).toBe(before.tracks);
    });

    it("goes ahead once the playlists have loaded", async () => {
      await playlistsLoader.start();
      if (WRITES[name].needsAlbums) await orgLoader.start();
      await WRITES[name].call(usePlaylistsStore.getState());
      expect(writeCalls().length).toBeGreaterThan(0);
    });
  });

  it("holds an album add until the albums have loaded too", async () => {
    await playlistsLoader.start();
    await expect(usePlaylistsStore.getState().addAlbums(1, [4], true)).rejects.toSatisfy(isNotReady);
    expect(writeCalls()).toEqual([]);
    await orgLoader.start();
    await usePlaylistsStore.getState().addAlbums(1, [4], true);
    expect(writeCalls().length).toBe(1);
  });
});
