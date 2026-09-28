// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useAppStore } from "./store";
import { useOrganizeStore } from "./organize/store";
import { usePlayerStore } from "./player/store";

// -- IPC Imports --
import * as ipc from "../lib/ipc";

// -- Type Imports --
import type { AlbumTrackRow, LibrarySyncSummary, Root, TrackRow } from "../types";

// The scan, sync and read commands the store drives, stubbed per test.
vi.mock("../lib/ipc", () => ({
  addRoot: vi.fn(),
  cancelScan: vi.fn(async () => {}),
  createScanChannel: vi.fn(() => ({})),
  getTracksByIds: vi.fn(),
  listRoots: vi.fn(),
  listTracks: vi.fn(),
  loadOrganization: vi.fn(async () => ({ albums: [], membership: [], genres: [] })),
  rescanAll: vi.fn(),
  rescanLibrary: vi.fn(async () => {}),
}));

vi.mock("../lib/dialog", () => ({ pickFolder: vi.fn() }));

const mocked = vi.mocked(ipc);

function syncTotals(over: Partial<LibrarySyncSummary> = {}): LibrarySyncSummary {
  return {
    inserted: 0,
    updated: 0,
    missing: 0,
    returned: 0,
    deferred: 0,
    errors: 0,
    offline_roots: [],
    ...over,
  };
}

// A track row with only the id and title meaningful; the store never reads the rest here.
const track = (id: number, title = `t${id}`) => ({ id, title, missing_at: null }) as unknown as TrackRow;
const root: Root = { id: 1, path: "/music", track_count: 1 };
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
  useOrganizeStore.setState({ org: { albums: [], membership: [] } });
  mocked.listRoots.mockResolvedValue([root]);
  mocked.listTracks.mockResolvedValue({ rows: [track(1)] } as never);
});

afterEach(() => {
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

describe("sync deltas", () => {
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
});
