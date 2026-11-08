// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { useVisualizerDefaults } from "./visualizerDefaults";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

vi.mock("../../lib/ipc", () => ({
  getVisualizerDefaults: vi.fn(),
  setAlbumVisualizer: vi.fn(async () => {}),
  setTrackVisualizer: vi.fn(async () => {}),
}));

// The playing track, stubbed so a test chooses which write lands on the stage.
const { playing } = vi.hoisted(() => ({ playing: { id: null as number | null } }));
vi.mock("./store", () => ({
  usePlayerStore: { getState: () => ({ status: { track_id: playing.id } }) },
}));

const mocked = vi.mocked(ipc);
const ALBUM_KEY = "album:7";
const read = { albums: [{ album_id: 7, kind: "nebula" }], tracks: [{ track_id: 3, kind: "terrain" }] };

const state = () => useVisualizerDefaults.getState();

// Runs an action to completion, flushing the retry backoff timers it may sleep on.
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  playing.id = null;
  useVisualizerDefaults.setState({ status: "loading", albums: {}, tracks: {}, override: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("load", () => {
  it("retries a rejected boot read and never lands an empty ready store", async () => {
    mocked.getVisualizerDefaults.mockRejectedValueOnce("not ready").mockResolvedValue(read);
    const seen: string[] = [];
    const unsubscribe = useVisualizerDefaults.subscribe((s) => {
      if (s.status === "ready") seen.push(JSON.stringify(s.albums));
    });

    expect(await settle(state().load())).toBe(true);
    unsubscribe();
    expect(mocked.getVisualizerDefaults).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([JSON.stringify({ 7: "nebula" })]);
    expect(state()).toMatchObject({ status: "ready", albums: { 7: "nebula" }, tracks: { 3: "terrain" } });
  });

  it("reports failed, not empty, when every retry rejects", async () => {
    mocked.getVisualizerDefaults.mockRejectedValue("down");
    expect(await settle(state().load())).toBe(false);
    expect(state().status).toBe("failed");
  });

  it("keeps the held defaults when a reload fails", async () => {
    mocked.getVisualizerDefaults.mockResolvedValueOnce(read).mockRejectedValue("down");
    await settle(state().load());
    expect(await settle(state().load())).toBe(false);
    expect(state()).toMatchObject({ status: "ready", albums: { 7: "nebula" } });
  });

  it("recovers from failed on a later load", async () => {
    mocked.getVisualizerDefaults.mockRejectedValue("down");
    await settle(state().load());
    mocked.getVisualizerDefaults.mockResolvedValue(read);
    expect(await settle(state().load())).toBe(true);
    expect(state().status).toBe("ready");
  });

  it("joins a load already on the wire", async () => {
    mocked.getVisualizerDefaults.mockResolvedValue(read);
    const a = state().load();
    const b = state().load();
    await settle(Promise.all([a, b]));
    expect(mocked.getVisualizerDefaults).toHaveBeenCalledTimes(1);
  });
});

describe("writes", () => {
  beforeEach(() => {
    useVisualizerDefaults.setState({ status: "ready", albums: { 7: "nebula" }, tracks: {} });
  });

  it("applies optimistically and persists", async () => {
    const done = state().setAlbumDefault(7, "glass");
    expect(state().albums[7]).toBe("glass");
    expect(await done).toBe(true);
    expect(mocked.setAlbumVisualizer).toHaveBeenCalledWith(7, "glass");
  });

  it("removes the entry on a clear", async () => {
    await state().setAlbumDefault(7, null);
    expect(7 in state().albums).toBe(false);
    expect(mocked.setAlbumVisualizer).toHaveBeenCalledWith(7, null);
  });

  it("rolls back a rejected write", async () => {
    mocked.setTrackVisualizer.mockRejectedValueOnce("db");
    expect(await state().setTrackDefault(3, "warp")).toBe(false);
    expect(3 in state().tracks).toBe(false);
  });

  it("refuses to write before the defaults are read", async () => {
    useVisualizerDefaults.setState({ status: "failed", albums: {} });
    expect(await state().setAlbumDefault(7, "glass")).toBe(false);
    expect(mocked.setAlbumVisualizer).not.toHaveBeenCalled();
    expect(state().albums).toEqual({});
  });

  it("ends the override on a write for the overridden album", async () => {
    state().setOverride({ kind: "bloom", albumKey: ALBUM_KEY });
    await state().setAlbumDefault(7, "bloom");
    expect(state().override).toBeNull();
  });

  it("ends the override on a write for the playing track only", async () => {
    playing.id = 3;
    state().setOverride({ kind: "bloom", albumKey: ALBUM_KEY });
    await state().setTrackDefault(6, "warp");
    expect(state().override).not.toBeNull();
    await state().setTrackDefault(3, "warp");
    expect(state().override).toBeNull();
  });

  it("keeps the temporary pick when a default is cleared", async () => {
    state().setOverride({ kind: "bloom", albumKey: ALBUM_KEY });
    await state().setAlbumDefault(7, null);
    expect(state().override).toEqual({ kind: "bloom", albumKey: ALBUM_KEY });
  });

  it("restores the override when the write that ended it is rejected", async () => {
    mocked.setAlbumVisualizer.mockRejectedValueOnce("db");
    state().setOverride({ kind: "bloom", albumKey: ALBUM_KEY });
    await state().setAlbumDefault(7, "bloom");
    expect(state().albums[7]).toBe("nebula");
    expect(state().override).toEqual({ kind: "bloom", albumKey: ALBUM_KEY });
  });

  it("clears the override on request", () => {
    state().setOverride({ kind: "bloom", albumKey: ALBUM_KEY });
    state().clearOverride();
    expect(state().override).toBeNull();
  });
});
