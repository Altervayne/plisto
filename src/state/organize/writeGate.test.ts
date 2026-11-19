// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- State Imports --
import { useAppStore } from "../store";
import { orgLoader, useOrganizeStore } from "./store";
import { playlistsLoader } from "../playlists/store";

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

const FIELDS = { title: "x", album_artist: null, year: null, genre: null };

const album = { id: 4, title: "a", album_artist: null, year: null, genre: null, kind: "album", track_count: 1 };
const member = {
  album_id: 4,
  track_id: 1,
  title_override: null,
  artist_override: null,
  track_no: 1,
  disc_no: 1,
  keep_own_cover: false,
  genre_ids: [],
};
const snapshot = { albums: [album], membership: [member], genres: [] };

type Store = ReturnType<typeof useOrganizeStore.getState>;

/** Every store method that is not a write: reads, selection, error and history housekeeping. */
const NOT_WRITES = [
  "loadOrganization",
  "refreshOrganization",
  "loadGenres",
  "clearError",
  "resetHistory",
  "reprojectTrackFromApp",
  "genreRemovalImpact",
  "toggleSelect",
  "selectOnly",
  "selectRange",
  "addSelection",
  "removeSelection",
  "clearSelection",
];

/** The writes, each called with arguments that would change the seeded projection. */
const WRITES: Record<string, (s: Store) => unknown> = {
  commitAlbumFields: (s) => s.commitAlbumFields(4, FIELDS),
  commitTrackOverrides: (s) =>
    s.commitTrackOverrides(4, 1, { title_override: "x", artist_override: null, track_no: 1, disc_no: 1 }),
  setAlbumLayout: (s) => s.setAlbumLayout(4, [{ track_id: 1, disc_no: 2, track_no: 1 }]),
  assignTracks: (s) => s.assignTracks(4, [2]),
  unassignTracks: (s) => s.unassignTracks(4, [1]),
  undo: (s) => s.undo(),
  redo: (s) => s.redo(),
  createAlbum: (s) => s.createAlbum(FIELDS, [1]),
  createAlbumsFromTags: (s) => s.createAlbumsFromTags([]),
  mergeDuplicates: (s) => s.mergeDuplicates(1, [2]),
  createSingle: (s) => s.createSingle(1),
  deleteAlbum: (s) => s.deleteAlbum(4),
  deleteAlbums: (s) => s.deleteAlbums([4]),
  setAlbumCover: (s) => s.setAlbumCover(4, "a.png"),
  removeAlbumCover: (s) => s.removeAlbumCover(4),
  setTrackKeepOwnCover: (s) => s.setTrackKeepOwnCover(4, [1], true),
  createGenre: (s) => s.createGenre("g"),
  renameGenre: (s) => s.renameGenre(1, "g"),
  deleteGenre: (s) => s.deleteGenre(1),
  mergeGenres: (s) => s.mergeGenres(1, 2),
  addAlbumGenre: (s) => s.addAlbumGenre(4, 9),
  removeAlbumGenre: (s) => s.removeAlbumGenre(4, 9),
  setTrackGenres: (s) => s.setTrackGenres(1, [9]),
};

const writeCalls = () =>
  invoke.mock.calls.filter(([cmd]) => cmd !== "load_organization" && cmd !== "load_playlists");

function seed(): void {
  useAppStore.setState({ tracks: [{ id: 2, genre_ids: [], disc_edit: null, raw_disc_no: null } as never] });
  useOrganizeStore.setState({
    org: { albums: [album, { ...album, id: 5 }] as never, membership: [{ ...member, genre_ids: [9] }] as never },
    // One undoable step on each side, so undo and redo have something to replay.
    past: [{ kind: "setAlbumFields", albumId: 4, next: FIELDS, prev: { ...FIELDS, title: "a" } }],
    future: [{ kind: "setAlbumFields", albumId: 4, next: FIELDS, prev: { ...FIELDS, title: "a" } }],
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_organization") return snapshot;
    if (cmd === "load_playlists") return { playlists: [], tracks: [], album_entries: [] };
    if (cmd === "genre_removal_impact") return { tracks: 0 };
    return { id: 1, created: [], extended: [] };
  });
  orgLoader.reset();
  playlistsLoader.reset();
  seed();
});

afterEach(() => {
  orgLoader.reset();
  playlistsLoader.reset();
});

describe("organize write gate", () => {
  it("covers every function the store exposes", () => {
    const functions = Object.entries(useOrganizeStore.getState())
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .filter((key) => !NOT_WRITES.includes(key));
    expect(functions.sort()).toEqual(Object.keys(WRITES).sort());
  });

  describe.each(Object.keys(WRITES))("%s", (name) => {
    it("is refused while the albums have not loaded", async () => {
      const before = useOrganizeStore.getState();
      const outcome = await Promise.resolve(WRITES[name](before)).then(
        () => null,
        (e: unknown) => e,
      );
      if (outcome !== null) expect(isNotReady(outcome)).toBe(true);
      const after = useOrganizeStore.getState();
      expect(writeCalls()).toEqual([]);
      expect(after.org).toBe(before.org);
      expect(after.past).toBe(before.past);
      expect(after.future).toBe(before.future);
    });

    it("goes ahead once the albums and playlists have loaded", async () => {
      await orgLoader.start();
      await playlistsLoader.start();
      seed();
      await WRITES[name](useOrganizeStore.getState());
      expect(writeCalls().length).toBeGreaterThan(0);
    });
  });

  it("refuses an async write with a not-ready rejection", async () => {
    await expect(useOrganizeStore.getState().createAlbum(FIELDS, [1])).rejects.toSatisfy(isNotReady);
  });

  it("holds a write that also touches playlists until the playlists have loaded", async () => {
    await orgLoader.start();
    await expect(useOrganizeStore.getState().mergeDuplicates(1, [2])).rejects.toSatisfy(isNotReady);
    expect(writeCalls()).toEqual([]);
  });

  it("holds the undo and redo of a duplicate merge until the playlists have loaded", async () => {
    await orgLoader.start();
    const merge = { kind: "duplicateMerge", keeperId: 1, discardIds: [2], receipt: {}, applied: true } as never;
    useOrganizeStore.setState({ past: [merge], future: [merge] });
    useOrganizeStore.getState().undo();
    useOrganizeStore.getState().redo();
    expect(writeCalls()).toEqual([]);
    expect(useOrganizeStore.getState().past).toEqual([merge]);
    expect(useOrganizeStore.getState().future).toEqual([merge]);

    await playlistsLoader.start();
    useOrganizeStore.getState().undo();
    expect(writeCalls().length).toBeGreaterThan(0);
  });

  it("reads the live flag, so a write that was refused goes through after the load", async () => {
    const store = useOrganizeStore.getState();
    store.unassignTracks(4, [1]);
    expect(writeCalls()).toEqual([]);
    await orgLoader.start();
    seed();
    store.unassignTracks(4, [1]);
    expect(writeCalls().length).toBeGreaterThan(0);
  });
});
