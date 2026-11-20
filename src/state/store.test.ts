// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useAppStore } from "./store";
import { orgLoader, useOrganizeStore } from "./organize/store";
import { playlistsLoader } from "./playlists/store";
import { useFileWritesStore } from "./fileWrites/store";
import { usePlayerStore } from "./player/store";

// -- IPC Imports --
import * as dialog from "../lib/dialog";
import * as ipc from "../lib/ipc";

// -- Type Imports --
import type { AlbumTrackRow, LibrarySyncSummary, RelinkCandidate, Root, TrackRow } from "../types";

// The scan, sync and read commands the store drives, stubbed per test.
vi.mock("../lib/ipc", () => ({
  addRoot: vi.fn(),
  cancelScan: vi.fn(async () => {}),
  createScanChannel: vi.fn(() => ({})),
  getTracksByIds: vi.fn(),
  listRoots: vi.fn(),
  listTracks: vi.fn(),
  loadOrganization: vi.fn(async () => ({ albums: [], membership: [], genres: [] })),
  loadPlaylists: vi.fn(),
  locateFolder: vi.fn(),
  relinkCandidates: vi.fn(),
  relocateRoot: vi.fn(),
  removeMissingTracks: vi.fn(),
  removeRoot: vi.fn(async () => {}),
  rescanAll: vi.fn(),
  rescanLibrary: vi.fn(async () => {}),
}));

vi.mock("../lib/dialog", () => ({ pickFolder: vi.fn() }));

const mocked = vi.mocked(ipc);
const mockedDialog = vi.mocked(dialog);

function syncTotals(over: Partial<LibrarySyncSummary> = {}): LibrarySyncSummary {
  return {
    inserted: 0,
    updated: 0,
    missing: 0,
    returned: 0,
    deferred: 0,
    errors: 0,
    issues: 0,
    new_issues: 0,
    offline_roots: [],
    ...over,
  };
}

// A track row with only the id and title meaningful; the store never reads the rest here.
const track = (id: number, title = `t${id}`) => ({ id, title, missing_at: null }) as unknown as TrackRow;
const root: Root = { id: 1, path: "/music", track_count: 1, missing_count: 0 };
const ids = () => useAppStore.getState().tracks.map((r) => r.id);

// Runs an action to completion, flushing the retry backoff timers it may sleep on.
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  useAppStore.getState().reset();
  orgLoader.reset();
  playlistsLoader.reset();
  useOrganizeStore.setState({ org: { albums: [], membership: [] } });
  mocked.listRoots.mockResolvedValue([root]);
  mocked.listTracks.mockResolvedValue({ rows: [track(1)] } as never);
  mocked.loadOrganization.mockResolvedValue({ albums: [], membership: [], genres: [] });
  mocked.loadPlaylists.mockResolvedValue({ playlists: [], tracks: [], album_entries: [] });
});

afterEach(() => {
  useAppStore.getState().reset();
  orgLoader.reset();
  playlistsLoader.reset();
  vi.useRealTimers();
});

describe("quiet rescans", () => {
  it("queue a background pass and leave the state to the sync events", async () => {
    await useAppStore.getState().rescanQuiet(7);
    expect(mocked.rescanLibrary).toHaveBeenCalledWith(7);
    expect(useAppStore.getState().scan.status).toBe("idle");
  });

  it("land a rejected request as a quiet error, never a blocking one", async () => {
    mocked.rescanLibrary.mockRejectedValue("library sync is unavailable");
    await useAppStore.getState().rescanQuiet();
    expect(useAppStore.getState().scan).toMatchObject({ status: "error", mode: "quiet" });
  });
});

describe("sync ticks", () => {
  it("drive a quiet scan from its first tick to its last", () => {
    const { applySyncTick } = useAppStore.getState();
    applySyncTick({ running: true, scanned: 3, total: 12, deferred: 0 });
    expect(useAppStore.getState().scan).toMatchObject({
      status: "scanning",
      mode: "quiet",
      progress: { scanned: 3, total: 12 },
    });
    applySyncTick({ running: false, scanned: 12, total: 12, deferred: 0 });
    expect(useAppStore.getState().scan).toMatchObject({ status: "done", mode: "quiet" });
  });

  it("are ignored while a blocking scan runs", () => {
    const blocking = { ...useAppStore.getState().scan, status: "scanning", mode: "blocking" } as const;
    useAppStore.setState({ scan: blocking });
    useAppStore.getState().applySyncTick({ running: true, scanned: 1, total: 2, deferred: 0 });
    useAppStore.getState().applySyncTick({ running: false, scanned: 2, total: 2, deferred: 0 });
    expect(useAppStore.getState().scan).toEqual(blocking);
  });
});

// Boots on the default mocks so every projection has landed, then clears the call counts.
async function bootAndClear(): Promise<void> {
  await useAppStore.getState().boot();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllMocks();
}

describe("sync deltas", () => {
  beforeEach(bootAndClear);

  it("patch rows by id, and give the same rows when applied twice", async () => {
    useAppStore.setState({ tracks: [track(1), track(2)] });
    mocked.getTracksByIds.mockResolvedValue([track(2, "renamed"), track(3)]);

    useAppStore.getState().queueDelta({ ids: [2, 3] });
    await settle(useAppStore.getState().flushDelta());
    const once = useAppStore.getState().tracks;
    useAppStore.getState().queueDelta({ ids: [2, 3] });
    await settle(useAppStore.getState().flushDelta());

    expect(useAppStore.getState().tracks).toEqual(once);
    expect(ids()).toEqual([1, 2, 3]);
    expect(once[1]).toMatchObject({ title: "renamed" });
  });

  it("gather while held and apply as one batch once released", async () => {
    mocked.getTracksByIds.mockResolvedValue([]);
    const s = useAppStore.getState();
    s.holdSync("export");
    s.holdSync("purgeConfirm");
    s.queueDelta({ ids: [1, 2] });
    s.queueDelta({ ids: [2, 4] });
    await settle(s.flushDelta());
    expect(mocked.getTracksByIds).not.toHaveBeenCalled();

    s.releaseSync("export");
    await vi.runAllTimersAsync();
    expect(mocked.getTracksByIds).not.toHaveBeenCalled();

    s.releaseSync("purgeConfirm");
    await vi.runAllTimersAsync();
    expect(mocked.getTracksByIds).toHaveBeenCalledTimes(1);
    expect(mocked.getTracksByIds).toHaveBeenCalledWith([1, 2, 4]);
  });

  it("gather while a tag write holds sync and apply once it releases", async () => {
    mocked.getTracksByIds.mockResolvedValue([]);
    const s = useAppStore.getState();
    s.holdSync("stamp");
    s.queueDelta({ ids: [7] });
    await settle(s.flushDelta());
    expect(mocked.getTracksByIds).not.toHaveBeenCalled();

    s.releaseSync("stamp");
    await vi.runAllTimersAsync();
    expect(mocked.getTracksByIds).toHaveBeenCalledWith([7]);
  });

  it("keep the current rows when the fetch and the fallback reload both fail", async () => {
    useAppStore.setState({ tracks: [track(1), track(2)] });
    mocked.getTracksByIds.mockRejectedValue("locked");
    mocked.listTracks.mockRejectedValue("locked");

    useAppStore.getState().queueDelta({ ids: [2] });
    await vi.runAllTimersAsync();
    expect(mocked.listTracks).toHaveBeenCalled();
    expect(ids()).toEqual([1, 2]);
    expect(useAppStore.getState().scan).toMatchObject({ status: "error", mode: "quiet" });
  });

  it("run the full refresh on a reload", async () => {
    mocked.listTracks.mockResolvedValue({ rows: [track(1), track(9)] } as never);
    useAppStore.getState().queueDelta({ reload: true });
    await vi.runAllTimersAsync();
    expect(mocked.getTracksByIds).not.toHaveBeenCalled();
    expect(ids()).toEqual([1, 9]);
  });

  it("do not read a first-run reload as failed while the tracks read has never run", async () => {
    useAppStore.getState().reset();
    orgLoader.reset();
    playlistsLoader.reset();
    mocked.listRoots.mockResolvedValue([]);
    mocked.loadOrganization.mockResolvedValue({ albums: [], membership: [], genres: [] });
    mocked.loadPlaylists.mockResolvedValue({ playlists: [], tracks: [], album_entries: [] });
    await useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.listTracks).not.toHaveBeenCalled();
    useAppStore.getState().queueDelta({ reload: true });
    await vi.runAllTimersAsync();
    expect(useAppStore.getState().scan.status).not.toBe("error");
  });

  it("refresh the organization only when a changed track is filed", async () => {
    mocked.getTracksByIds.mockResolvedValue([track(5)]);
    useAppStore.getState().queueDelta({ ids: [5] });
    await vi.runAllTimersAsync();
    expect(mocked.loadOrganization).not.toHaveBeenCalled();

    const member = { album_id: 1, track_id: 5 } as AlbumTrackRow;
    useOrganizeStore.setState({ org: { albums: [], membership: [member] } });
    useAppStore.getState().queueDelta({ ids: [5] });
    await vi.runAllTimersAsync();
    expect(mocked.loadOrganization).toHaveBeenCalledTimes(1);
  });

  it("never touch the player store", async () => {
    const before = usePlayerStore.getState();
    mocked.getTracksByIds.mockResolvedValue([track(1, "changed")]);
    useAppStore.getState().queueDelta({ ids: [1] });
    useAppStore.getState().queueDelta({ reload: true });
    await vi.runAllTimersAsync();
    expect(usePlayerStore.getState()).toBe(before);
  });
});

describe("sync summaries", () => {
  it("stamp the check, raise the added caption, and read as the summary line", () => {
    useAppStore.getState().applySyncTick({ running: true, scanned: 40, total: 40, deferred: 0 });
    useAppStore.getState().applySyncSummary(syncTotals({ inserted: 12, errors: 1, offline_roots: [3] }));

    const { scan } = useAppStore.getState();
    expect(scan.checkedAt).not.toBeNull();
    expect(scan.added?.n).toBe(12);
    expect(scan.summary).toMatchObject({
      source: "sync",
      inserted: 12,
      errors: 1,
      offline_roots: [3],
    });
    // Unreadable files are reported, not a failed check.
    expect(scan.status).toBe("scanning");
  });

  it("leave the caption alone when nothing was added", () => {
    useAppStore.getState().applySyncSummary(syncTotals({ updated: 4 }));
    expect(useAppStore.getState().scan.added).toBeNull();
  });
});

describe("roots state", () => {
  it("stores the latest watch modes", () => {
    useAppStore.getState().setRootStates([{ id: 1, mode: "offline" }]);
    expect(useAppStore.getState().rootStates).toEqual([{ id: 1, mode: "offline" }]);
  });
});

describe("blocking scans", () => {
  it("tag their landed summary as blocking", async () => {
    mocked.addRoot.mockResolvedValue({
      total: 5,
      seen: 5,
      inserted: 5,
      updated: 0,
      skipped: 0,
      removed: 0,
      missing: 0,
      returned: 0,
      errors: 0,
      issues: 0,
      cancelled: false,
      offline_roots: [],
      deferred: 0,
    });
    await settle(useAppStore.getState().addRootPath("/new"));
    expect(useAppStore.getState().scan.summary).toMatchObject({ source: "blocking", total: 5 });
  });

  it("keep their full-screen error on a real failure", async () => {
    mocked.addRoot.mockRejectedValue("this folder overlaps a folder already in your library");
    await settle(useAppStore.getState().addRootPath("/new"));
    expect(useAppStore.getState().scan).toMatchObject({ status: "error", mode: "blocking" });
  });

  it("turn a busy rejection into a quiet error", async () => {
    mocked.addRoot.mockRejectedValue("a scan is already running");
    await settle(useAppStore.getState().addRootPath("/new"));
    expect(useAppStore.getState().scan).toMatchObject({ status: "error", mode: "quiet" });
  });

  it("show the file write notice, and no scan error, when a file write holds the lock", async () => {
    useFileWritesStore.setState({ busyAt: null });
    mocked.addRoot.mockRejectedValue("a file write is running");
    await settle(useAppStore.getState().addRootPath("/new"));
    expect(useAppStore.getState().scan.status).not.toBe("error");
    expect(useFileWritesStore.getState().busyAt).not.toBeNull();
  });
});

describe("boot", () => {
  it("retries a rejected early read rather than reading it as empty", async () => {
    mocked.listRoots.mockRejectedValueOnce("not ready").mockResolvedValue([root]);
    mocked.listTracks
      .mockRejectedValueOnce("not ready")
      .mockResolvedValue({ rows: [track(1), track(2)] } as never);

    await settle(useAppStore.getState().boot());
    const s = useAppStore.getState();
    expect(s.booted).toBe(true);
    expect(s.roots).toEqual([root]);
    expect(ids()).toEqual([1, 2]);
  });

  it("starts the organization and playlists reads before the gate opens, without waiting on them", async () => {
    mocked.loadOrganization.mockReturnValue(new Promise(() => {}));
    mocked.loadPlaylists.mockReturnValue(new Promise(() => {}));

    await useAppStore.getState().boot();
    expect(useAppStore.getState().booted).toBe(true);
    expect(mocked.loadOrganization).toHaveBeenCalledTimes(1);
    expect(mocked.loadPlaylists).toHaveBeenCalledTimes(1);
    expect(useOrganizeStore.getState().orgReady).toBe(false);
  });

  it("joins the running reads when called twice", async () => {
    await useAppStore.getState().boot();
    await useAppStore.getState().boot();
    expect(mocked.listRoots).toHaveBeenCalledTimes(1);
    expect(mocked.listTracks).toHaveBeenCalledTimes(1);
    expect(mocked.loadOrganization).toHaveBeenCalledTimes(1);
    expect(mocked.loadPlaylists).toHaveBeenCalledTimes(1);
  });

  it("holds the gate through twenty rejected roots reads, never reading as empty", async () => {
    for (let i = 0; i < 20; i++) mocked.listRoots.mockRejectedValueOnce("not ready");
    const booting = useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useAppStore.getState().booted).toBe(false);
    expect(useAppStore.getState().roots).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await booting;
    expect(useAppStore.getState().booted).toBe(true);
    expect(useAppStore.getState().roots).toEqual([root]);
  });

  it("holds the gate through a roots read that never settles, flagging it stalled", async () => {
    mocked.listRoots.mockReturnValueOnce(new Promise(() => {})).mockReturnValue(new Promise(() => {}));
    void useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useAppStore.getState().booted).toBe(false);
    expect(useAppStore.getState().bootStalled).toBe(true);
  });

  it("retries a waiting roots read at once on retryBoot", async () => {
    mocked.listRoots.mockRejectedValueOnce("not ready").mockResolvedValue([root]);
    const booting = useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(10);
    expect(mocked.listRoots).toHaveBeenCalledTimes(1);
    useAppStore.getState().retryBoot();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.listRoots).toHaveBeenCalledTimes(2);
    await booting;
    expect(useAppStore.getState().booted).toBe(true);
  });

  it("recovers on the third attempt when two roots reads never settle", async () => {
    mocked.listRoots
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue([root]);
    void useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(mocked.listRoots).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().booted).toBe(true);
  });

  it("recovers from a tracks read that never settles", async () => {
    mocked.listTracks.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue({ rows: [track(4)] } as never);
    void useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useAppStore.getState().booted).toBe(true);
    expect(ids()).toEqual([4]);
    expect(useAppStore.getState().bootStalled).toBe(false);
  });

  it("wakes a waiting projection read on any sync delta", async () => {
    mocked.loadOrganization.mockRejectedValueOnce("early").mockResolvedValue({ albums: [], membership: [], genres: [] });
    await useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(10);
    expect(mocked.loadOrganization).toHaveBeenCalledTimes(1);
    mocked.getTracksByIds.mockResolvedValue([]);
    useAppStore.getState().queueDelta({ ids: [9] });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocked.loadOrganization).toHaveBeenCalledTimes(2);
    expect(useOrganizeStore.getState().orgReady).toBe(true);
  });
});

const doneSummary = {
  total: 5,
  seen: 5,
  inserted: 0,
  updated: 5,
  skipped: 0,
  removed: 0,
  missing: 2,
  returned: 0,
  errors: 0,
  issues: 0,
  cancelled: false,
  offline_roots: [],
  deferred: 0,
};

const candidate = (over: Partial<RelinkCandidate> = {}): RelinkCandidate => ({
  root_id: 1,
  path: "/music",
  total: 100,
  sampled: 48,
  matched: 46,
  partial: false,
  ...over,
});

describe("adding a folder", () => {
  beforeEach(() => {
    mockedDialog.pickFolder.mockResolvedValue("/new");
    mocked.addRoot.mockResolvedValue(doneSummary);
    useAppStore.setState({ roots: [root] });
  });

  it("skips the relink check when no root is offline or all-missing", async () => {
    await settle(useAppStore.getState().addRoot());
    expect(mocked.relinkCandidates).not.toHaveBeenCalled();
    expect(mocked.addRoot).toHaveBeenCalledWith("/new", expect.anything());
  });

  it("holds an offer, and does not add, when a candidate matches", async () => {
    useAppStore.getState().setRootStates([{ id: 1, mode: "offline" }]);
    mocked.relinkCandidates.mockResolvedValue([candidate()]);

    await settle(useAppStore.getState().addRoot());
    expect(useAppStore.getState().relinkOffer).toEqual({ path: "/new", candidate: candidate() });
    expect(mocked.addRoot).not.toHaveBeenCalled();
  });

  it("checks an all-missing root that is online", async () => {
    useAppStore.setState({ roots: [{ ...root, track_count: 3, missing_count: 3 }] });
    mocked.relinkCandidates.mockResolvedValue([]);
    await settle(useAppStore.getState().addRoot());
    expect(mocked.relinkCandidates).toHaveBeenCalledWith("/new");
    expect(mocked.addRoot).toHaveBeenCalled();
  });

  it("adds as today when the candidates tie", async () => {
    useAppStore.getState().setRootStates([{ id: 1, mode: "offline" }]);
    mocked.relinkCandidates.mockResolvedValue([
      candidate({ root_id: 1 }),
      candidate({ root_id: 2 }),
    ]);
    await settle(useAppStore.getState().addRoot());
    expect(useAppStore.getState().relinkOffer).toBeNull();
    expect(mocked.addRoot).toHaveBeenCalled();
  });

  it("adds as today when the check fails", async () => {
    useAppStore.getState().setRootStates([{ id: 1, mode: "offline" }]);
    mocked.relinkCandidates.mockRejectedValue("boom");
    await settle(useAppStore.getState().addRoot());
    expect(mocked.addRoot).toHaveBeenCalled();
  });

  it("adds nothing when the picker is cancelled", async () => {
    mockedDialog.pickFolder.mockResolvedValue(null);
    await settle(useAppStore.getState().addRoot());
    expect(mocked.relinkCandidates).not.toHaveBeenCalled();
    expect(mocked.addRoot).not.toHaveBeenCalled();
  });
});

describe("the relink prompt", () => {
  beforeEach(() => {
    useAppStore.setState({ relinkOffer: { path: "/new", candidate: candidate({ root_id: 7 }) } });
    mocked.addRoot.mockResolvedValue(doneSummary);
    mocked.relocateRoot.mockResolvedValue({
      kind: "done",
      summary: doneSummary,
      merged: false,
      albums_replaced: 0,
    });
  });

  it("adds the folder as new on asNew", async () => {
    await settle(useAppStore.getState().resolveRelink("asNew"));
    expect(mocked.addRoot).toHaveBeenCalledWith("/new", expect.anything());
    expect(mocked.relocateRoot).not.toHaveBeenCalled();
    expect(useAppStore.getState().relinkOffer).toBeNull();
  });

  it("relocates the candidate's root on relink", async () => {
    const result = await settle(useAppStore.getState().resolveRelink("relink"));
    expect(mocked.relocateRoot).toHaveBeenCalledWith(7, "/new", expect.anything());
    expect(mocked.addRoot).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "done" });
    expect(useAppStore.getState().relinkOffer).toBeNull();
  });

  it("does nothing on cancel beyond clearing the offer", async () => {
    await settle(useAppStore.getState().resolveRelink("cancel"));
    expect(mocked.addRoot).not.toHaveBeenCalled();
    expect(mocked.relocateRoot).not.toHaveBeenCalled();
    expect(useAppStore.getState().relinkOffer).toBeNull();
  });

  it("ignores a choice when no offer is held", async () => {
    useAppStore.setState({ relinkOffer: null });
    expect(await settle(useAppStore.getState().resolveRelink("relink"))).toBeNull();
    expect(mocked.relocateRoot).not.toHaveBeenCalled();
  });
});

describe("with a stuck organization read", () => {
  beforeEach(async () => {
    mocked.loadOrganization.mockReturnValue(new Promise(() => {}));
    await useAppStore.getState().boot();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("lets a library reload through instead of holding the delta flush", async () => {
    mocked.listTracks.mockResolvedValue({ rows: [track(1), track(9)] } as never);
    useAppStore.getState().queueDelta({ reload: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(ids()).toEqual([1, 9]);
    expect(useAppStore.getState().pendingDelta).toEqual({ ids: [], reload: false });
  });

  it("does not report a library reload as failed while the organization is still loading", async () => {
    mocked.listTracks.mockResolvedValue({ rows: [track(1)] } as never);
    useAppStore.getState().queueDelta({ reload: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(useAppStore.getState().scan.status).not.toBe("error");
  });

  it("releases the purge hold", async () => {
    mocked.removeMissingTracks.mockResolvedValue({ removed: 1 } as never);
    const purge = useAppStore.getState().purgeGoneTracks([1]);
    await vi.advanceTimersByTimeAsync(100);
    await purge;
    expect(useAppStore.getState().syncHolds).toEqual([]);
  });
});

describe("locating a folder", () => {
  beforeEach(bootAndClear);

  const reloads = () => {
    mocked.listRoots.mockClear();
    mocked.listTracks.mockClear();
    mocked.loadPlaylists.mockClear();
    vi.mocked(mocked.loadOrganization).mockClear();
  };

  it("reloads roots, tracks, organization and playlists after a done outcome, then releases the hold", async () => {
    mocked.locateFolder.mockResolvedValue({ kind: "done", relinked: 3, merged: 1, stays: 0, albums_replaced: 0 });
    reloads();
    const result = await settle(useAppStore.getState().locateFolder(1, "/music/old", "/music/new"));
    expect(mocked.locateFolder).toHaveBeenCalledWith(1, "/music/old", "/music/new");
    expect(result.kind).toBe("done");
    expect(mocked.listRoots).toHaveBeenCalled();
    expect(mocked.listTracks).toHaveBeenCalled();
    expect(mocked.loadOrganization).toHaveBeenCalledTimes(1);
    expect(mocked.loadPlaylists).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().syncHolds).toEqual([]);
  });

  it("reloads nothing after a refusal", async () => {
    mocked.locateFolder.mockResolvedValue({ kind: "refused", reason: { code: "no_match" } });
    reloads();
    const result = await settle(useAppStore.getState().locateFolder(1, "/music/old", "/music/new"));
    expect(result).toEqual({ kind: "refused", reason: { code: "no_match" } });
    expect(mocked.listRoots).not.toHaveBeenCalled();
    expect(mocked.listTracks).not.toHaveBeenCalled();
    expect(mocked.loadOrganization).not.toHaveBeenCalled();
    expect(mocked.loadPlaylists).not.toHaveBeenCalled();
  });

  it("reports a held scan lock as busy and any other rejection as failed, reloading nothing", async () => {
    reloads();
    mocked.locateFolder.mockRejectedValueOnce("a scan is already running");
    expect(await useAppStore.getState().locateFolder(1, "/a", "/b")).toEqual({ kind: "busy", by: "scan" });
    mocked.locateFolder.mockRejectedValueOnce("disk on fire");
    expect(await useAppStore.getState().locateFolder(1, "/a", "/b")).toEqual({
      kind: "failed",
      message: "disk on fire",
    });
    expect(mocked.listTracks).not.toHaveBeenCalled();
    expect(useAppStore.getState().syncHolds).toEqual([]);
  });

  it("reports a running file write as busy too", async () => {
    reloads();
    mocked.locateFolder.mockRejectedValueOnce("a file write is running");
    expect(await useAppStore.getState().locateFolder(1, "/a", "/b")).toEqual({ kind: "busy", by: "fileWrite" });
    expect(useAppStore.getState().syncHolds).toEqual([]);
  });

  it("holds sync while the write is pending and turns a second call away as busy", async () => {
    let finish: (v: unknown) => void = () => {};
    mocked.locateFolder.mockReturnValueOnce(new Promise((ok) => (finish = ok)) as never);
    const first = useAppStore.getState().locateFolder(1, "/a", "/b");
    expect(useAppStore.getState().syncHolds).toEqual(["locate"]);
    expect(await useAppStore.getState().locateFolder(1, "/c", "/d")).toEqual({ kind: "busy" });
    expect(mocked.locateFolder).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().syncHolds).toEqual(["locate"]);
    finish({ kind: "refused", reason: { code: "no_match" } });
    await first;
    expect(useAppStore.getState().syncHolds).toEqual([]);
  });
});

describe("removing a root", () => {
  beforeEach(bootAndClear);

  it("reloads roots, tracks, organization and playlists", async () => {
    mocked.listRoots.mockResolvedValue([]);
    mocked.listTracks.mockResolvedValue({ rows: [] } as never);
    mocked.loadPlaylists.mockResolvedValue({ playlists: [], tracks: [], album_entries: [] });
    vi.mocked(mocked.loadOrganization).mockClear();
    mocked.loadPlaylists.mockClear();

    await settle(useAppStore.getState().removeRoot(1));
    expect(mocked.removeRoot).toHaveBeenCalledWith(1);
    expect(mocked.listRoots).toHaveBeenCalled();
    expect(mocked.listTracks).toHaveBeenCalled();
    expect(mocked.loadOrganization).toHaveBeenCalledTimes(1);
    expect(mocked.loadPlaylists).toHaveBeenCalledTimes(1);
  });
});

describe("relocating a root", () => {
  beforeEach(() => {
    mocked.loadPlaylists.mockResolvedValue({ playlists: [], tracks: [], album_entries: [] });
  });

  it("reloads roots, tracks, organization and playlists when done", async () => {
    const outcome = { kind: "done", summary: doneSummary, merged: true, albums_replaced: 2 } as const;
    mocked.relocateRoot.mockResolvedValue(outcome);

    const result = await settle(useAppStore.getState().relocateRoot(1, "/new"));
    expect(result).toEqual(outcome);
    expect(mocked.listRoots).toHaveBeenCalled();
    expect(mocked.listTracks).toHaveBeenCalled();
    expect(mocked.loadOrganization).toHaveBeenCalled();
    expect(mocked.loadPlaylists).toHaveBeenCalled();
    expect(useAppStore.getState().scan).toMatchObject({
      status: "done",
      summary: { source: "blocking", missing: 2 },
    });
  });

  it("restores the scan state on a refusal, with no blocking error", async () => {
    const before = useAppStore.getState().scan;
    mocked.relocateRoot.mockResolvedValue({ kind: "refused", reason: { code: "same" } });

    const result = await settle(useAppStore.getState().relocateRoot(1, "/new"));
    expect(result).toEqual({ kind: "refused", reason: { code: "same" } });
    expect(useAppStore.getState().scan).toEqual(before);
    expect(mocked.listRoots).not.toHaveBeenCalled();
    expect(mocked.loadPlaylists).not.toHaveBeenCalled();
  });

  it("returns busy and leaves the scan state as it was when a scan holds the lock", async () => {
    mocked.relocateRoot.mockRejectedValue("a scan is already running");
    const before = useAppStore.getState().scan;

    const result = await settle(useAppStore.getState().relocateRoot(1, "/new"));
    expect(result).toEqual({ kind: "busy", by: "scan" });
    expect(useAppStore.getState().scan).toEqual(before);
    expect(mocked.listRoots).not.toHaveBeenCalled();
  });

  it("reports a relocate refused by a running file write as such", async () => {
    mocked.relocateRoot.mockRejectedValue("a file write is running");
    const result = await settle(useAppStore.getState().relocateRoot(1, "/new"));
    expect(result).toEqual({ kind: "busy", by: "fileWrite" });
  });

  it("reloads and reports failed when the rescan after the commit breaks", async () => {
    mocked.relocateRoot.mockRejectedValue("disk error");

    const result = await settle(useAppStore.getState().relocateRoot(1, "/new"));
    expect(result).toEqual({ kind: "failed" });
    expect(useAppStore.getState().scan).toMatchObject({ status: "error", mode: "blocking" });
    expect(mocked.listRoots).toHaveBeenCalled();
    expect(mocked.loadPlaylists).toHaveBeenCalled();
  });
});
