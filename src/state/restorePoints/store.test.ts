// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- State Imports --
import { useAppStore } from "../store";
import { orgLoader, useOrganizeStore } from "../organize/store";
import { playlistsLoader, usePlaylistsStore } from "../playlists/store";
import { useCollectionStore } from "../collection/store";
import { usePlayerStore } from "../player/store";
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";
import { reportLibraryChange } from "../plugins/libraryWatch";
import { refusalFailure, useRestorePointsStore } from "./store";

// -- IPC Imports --
import { isNotReady } from "../../lib/ipc";

// -- Type Imports --
import type { RestoreOutcome, RestoreRefusal, RestoreSummary } from "../../types";

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

const FILE = "rp-1000-daily.sqlite";
const FIELDS = { title: "x", album_artist: null, year: null, genre: null };
const album = { id: 4, title: "a", album_artist: null, year: null, genre: null, kind: "album", track_count: 1 };
const summary: RestoreSummary = {
  albums: 2,
  singles: 0,
  playlists: 1,
  filed_tracks: 5,
  unmatched_tracks: 0,
  albums_not_recreated: 0,
  collapsed: 0,
  dropped_entries: 0,
  cleared_tracks: 0,
  unmatched: [],
};

const calls = (name: string) => invoke.mock.calls.filter(([cmd]) => cmd === name).length;

// The restore command stays pending until `finishRestore` answers it.
let finishRestore: (outcome: RestoreOutcome | Error) => void;
// Switches the organization read to the restored rows.
let afterRestore = false;

function mockBackend(): void {
  invoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "load_organization":
        return { albums: [afterRestore ? { ...album, id: 9 } : album], membership: [], genres: [] };
      case "load_playlists":
        return { playlists: [], tracks: [], album_entries: [] };
      case "list_tracks":
        return { rows: [] };
      case "get_visualizer_defaults":
        return { albums: [], tracks: [] };
      case "list_restore_points":
        return { points: [], disk_points: 0, disk_bytes: 0 };
      case "restore_from_point":
        return new Promise((resolve, reject) => {
          finishRestore = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
        });
      default:
        return { id: 1 };
    }
  });
}

// Loaded, with undo history, a selection and open album panes to lose.
async function seedLoaded(): Promise<void> {
  await orgLoader.start();
  await playlistsLoader.start();
  const step = { kind: "setAlbumFields", albumId: 4, next: FIELDS, prev: FIELDS } as never;
  useOrganizeStore.setState({ past: [step], future: [step], selection: new Set([1, 2]) });
  useCollectionStore.setState({ drawerAlbumId: 4, fullAlbumId: 4, browseFocusId: 4 });
  vi.clearAllMocks();
}

// Lets the restore reach its pending command.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  afterRestore = false;
  orgLoader.release();
  playlistsLoader.release();
  useRestorePointsStore.setState({ running: false, result: null, points: [], loaded: false });
  mockBackend();
});

afterEach(() => {
  orgLoader.reset();
  playlistsLoader.reset();
});

describe("restore", () => {
  it("refuses album and playlist writes while it runs", async () => {
    await seedLoaded();
    const run = useRestorePointsStore.getState().restore(FILE);
    await flush();

    expect(useRestorePointsStore.getState().running).toBe(true);
    expect(useOrganizeStore.getState().orgReady).toBe(false);
    expect(usePlaylistsStore.getState().ready).toBe(false);
    await expect(useOrganizeStore.getState().createAlbum(FIELDS, [1])).rejects.toSatisfy(isNotReady);
    await expect(usePlaylistsStore.getState().create("p")).rejects.toSatisfy(isNotReady);
    useOrganizeStore.getState().unassignTracks(4, [1]);
    expect(calls("create_album") + calls("create_playlist")).toBe(0);

    finishRestore({ kind: "done", summary, before_point: null });
    await run;
  });

  it("restarts the loaders and drops every held reference once done", async () => {
    await seedLoaded();
    const run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    finishRestore({ kind: "done", summary, before_point: "rp-2000-restore.sqlite" });
    const result = await run;

    expect(result).toEqual({ kind: "done", file: FILE, summary, beforePoint: "rp-2000-restore.sqlite" });
    expect(useRestorePointsStore.getState().result).toEqual(result);
    expect(useRestorePointsStore.getState().running).toBe(false);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    expect(usePlaylistsStore.getState().ready).toBe(true);
    expect(calls("load_organization")).toBe(1);
    expect(calls("load_playlists")).toBe(1);
    expect(calls("list_tracks")).toBe(1);
    expect(calls("get_visualizer_defaults")).toBe(1);
    expect(calls("list_restore_points")).toBe(1);

    const organize = useOrganizeStore.getState();
    expect(organize.past).toEqual([]);
    expect(organize.future).toEqual([]);
    expect(organize.selection.size).toBe(0);
    const panes = useCollectionStore.getState();
    expect([panes.drawerAlbumId, panes.fullAlbumId, panes.browseFocusId, panes.handoff]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(reportLibraryChange).toHaveBeenCalledWith({ track_ids: null, albums: true, playlists: true });
  });

  it("bumps the generation, clears the Browse focus pref and drops an album or playlist source", async () => {
    await seedLoaded();
    usePreferencesStore.setState({ values: { [PREF_KEYS.collectionBrowseFocus]: "4" } });
    usePlayerStore.setState({ playingFrom: { kind: "album", id: 4, label: "a" }, queue: [1, 2] });
    const before = useRestorePointsStore.getState().generation;
    const run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    finishRestore({ kind: "done", summary, before_point: null });
    await run;

    expect(useRestorePointsStore.getState().generation).toBe(before + 1);
    expect(usePreferencesStore.getState().values[PREF_KEYS.collectionBrowseFocus]).toBe("");
    expect(usePlayerStore.getState().playingFrom).toBeNull();
    expect(usePlayerStore.getState().queue).toEqual([1, 2]);
  });

  it("keeps a source that names no container, and a refusal leaves a playlist source alone", async () => {
    await seedLoaded();
    usePlayerStore.setState({ playingFrom: { kind: "tracks" } });
    const before = useRestorePointsStore.getState().generation;
    let run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    finishRestore({ kind: "done", summary, before_point: null });
    await run;
    expect(usePlayerStore.getState().playingFrom).toEqual({ kind: "tracks" });

    usePlayerStore.setState({ playingFrom: { kind: "playlist", id: 1, label: "p" } });
    run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    finishRestore({ kind: "refused", reason: { code: "busy" } });
    await run;
    expect(useRestorePointsStore.getState().generation).toBe(before + 1);
    expect(usePlayerStore.getState().playingFrom).toEqual({ kind: "playlist", id: 1, label: "p" });
  });

  it("holds sync and refuses every competing read until it ends, then reads afresh", async () => {
    await seedLoaded();
    const run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    expect(useAppStore.getState().syncHolds).toContain("restore");

    // A reload, a focus wake and a first read asked for mid-restore land nothing.
    await useOrganizeStore.getState().loadOrganization();
    await usePlaylistsStore.getState().load();
    await orgLoader.start();
    orgLoader.wake();
    await flush();
    expect(calls("load_organization")).toBe(0);
    expect(calls("load_playlists")).toBe(0);
    expect(useOrganizeStore.getState().orgReady).toBe(false);
    expect(usePlaylistsStore.getState().ready).toBe(false);

    afterRestore = true;
    finishRestore({ kind: "done", summary, before_point: null });
    await run;
    expect(useAppStore.getState().syncHolds).not.toContain("restore");
    expect(calls("load_organization")).toBe(1);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    expect(useOrganizeStore.getState().org.albums.map((a) => a.id)).toEqual([9]);
  });

  it("still releases and reads both loaders when dropping held references throws", async () => {
    await seedLoaded();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const drop = vi.spyOn(useCollectionStore.getState(), "resetAlbumRefs").mockImplementation(() => {
      throw new Error("boom");
    });
    const run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    finishRestore({ kind: "done", summary, before_point: null });
    const result = await run;
    drop.mockRestore();
    warn.mockRestore();

    expect(result?.kind).toBe("done");
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    expect(usePlaylistsStore.getState().ready).toBe(true);
    expect(calls("load_organization")).toBe(1);
  });

  it("is refused without asking the backend while a scan runs", async () => {
    await seedLoaded();
    useAppStore.setState({ scan: { ...useAppStore.getState().scan, status: "scanning" } });
    try {
      const result = await useRestorePointsStore.getState().restore(FILE);
      expect(result).toEqual({ kind: "refused", file: FILE, failure: { key: "busy", detail: null } });
      expect(calls("restore_from_point")).toBe(0);
      expect(useOrganizeStore.getState().orgReady).toBe(true);
      expect(useRestorePointsStore.getState().running).toBe(false);
    } finally {
      useAppStore.setState({ scan: { ...useAppStore.getState().scan, status: "idle" } });
    }
  });

  it("keeps the history and reloads no rows on a refusal", async () => {
    await seedLoaded();
    const past = useOrganizeStore.getState().past;
    const run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    finishRestore({ kind: "refused", reason: { code: "busy" } });
    const result = await run;

    expect(result).toEqual({ kind: "refused", file: FILE, failure: { key: "busy", detail: null } });
    expect(useOrganizeStore.getState().past).toBe(past);
    expect(useOrganizeStore.getState().future).toHaveLength(1);
    expect(useOrganizeStore.getState().selection.size).toBe(2);
    expect(useCollectionStore.getState().drawerAlbumId).toBe(4);
    expect(calls("list_tracks")).toBe(0);
    expect(calls("get_visualizer_defaults")).toBe(0);
    expect(reportLibraryChange).not.toHaveBeenCalled();
    // The projections read again: the only way back to ready.
    expect(useOrganizeStore.getState().orgReady).toBe(true);
    expect(usePlaylistsStore.getState().ready).toBe(true);
    expect(useRestorePointsStore.getState().running).toBe(false);
  });

  it("treats a rejected command as a failure that changed nothing", async () => {
    await seedLoaded();
    const run = useRestorePointsStore.getState().restore(FILE);
    await flush();
    finishRestore(new Error("index is unavailable"));
    const result = await run;

    expect(result).toMatchObject({ kind: "refused", failure: { key: "failed" } });
    expect(useOrganizeStore.getState().past).toHaveLength(1);
    expect(calls("list_tracks")).toBe(0);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });

  it("ignores a second restore while one runs", async () => {
    await seedLoaded();
    const first = useRestorePointsStore.getState().restore(FILE);
    await flush();
    expect(await useRestorePointsStore.getState().restore(FILE)).toBeNull();
    expect(calls("restore_from_point")).toBe(1);
    finishRestore({ kind: "done", summary, before_point: null });
    await first;
  });
});

describe("refusal mapping", () => {
  it("maps every refusal to its key", () => {
    const cases: [RestoreRefusal, string, string | null][] = [
      [{ code: "newer", format: 2 }, "newer", "2"],
      [{ code: "unreadable", message: "bad" }, "unreadable", "bad"],
      [{ code: "integrity", message: "rows" }, "integrity", "rows"],
      [{ code: "before_point", message: "disk" }, "before_point", "disk"],
      [{ code: "busy" }, "busy", null],
    ];
    for (const [reason, key, detail] of cases) {
      expect(refusalFailure(reason)).toEqual({ key, detail });
    }
  });
});

describe("plan and list", () => {
  it("maps a refused plan and a rejected one", async () => {
    const store = useRestorePointsStore.getState();
    invoke.mockResolvedValueOnce({ kind: "ready", summary });
    expect(await store.plan(FILE)).toEqual({ kind: "ready", summary });
    invoke.mockResolvedValueOnce({ kind: "refused", reason: { code: "newer", format: 3 } });
    expect(await store.plan(FILE)).toEqual({ kind: "refused", failure: { key: "newer", detail: "3" } });
    invoke.mockRejectedValueOnce(new Error("not a restore point"));
    expect(await store.plan("x")).toMatchObject({ kind: "refused", failure: { key: "failed" } });
  });

  it("holds the list with its disk use, and keeps it when a read fails", async () => {
    invoke.mockResolvedValueOnce({ points: [], disk_points: 17, disk_bytes: 48_000_000 });
    await useRestorePointsStore.getState().load();
    expect(useRestorePointsStore.getState()).toMatchObject({ diskPoints: 17, diskBytes: 48_000_000, loaded: true });
    invoke.mockRejectedValueOnce(new Error("nope"));
    await useRestorePointsStore.getState().load();
    expect(useRestorePointsStore.getState()).toMatchObject({ diskPoints: 17, loaded: true });
    expect(useRestorePointsStore.getState().error).not.toBeNull();
  });
});
