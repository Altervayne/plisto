// -- Library Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- IPC Imports --
import { albumCovers } from "../../lib/ipc";

// -- Utils Imports --
import {
  albumCoverVersion,
  invalidateAlbumCover,
  peekAlbumCover,
  requestAlbumCover,
  resetAlbumCoverBatch,
} from "./albumCoverBatch";

vi.mock("../../lib/ipc", () => ({ albumCovers: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset:${p}` }));

const mocked = vi.mocked(albumCovers);

function answer(ids: number[]) {
  return ids.map((album_id) => ({
    album_id,
    cover: { path: `c${album_id}`, width: 1, height: 1, source: "embedded" as const },
  }));
}

describe("albumCoverBatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked.mockReset();
    mocked.mockImplementation(async (ids) => answer(ids));
    resetAlbumCoverBatch();
  });
  afterEach(() => vi.useRealTimers());

  it("coalesces every request in a frame into one call per size", async () => {
    const all = [1, 2, 3].map((id) => requestAlbumCover(id, "grid"));
    const other = requestAlbumCover(4, "detail");
    await vi.runAllTimersAsync();
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked).toHaveBeenCalledWith([1, 2, 3], "grid");
    expect(await Promise.all(all)).toEqual(["asset:c1", "asset:c2", "asset:c3"]);
    expect(await other).toBe("asset:c4");
  });

  it("shares a repeat request and answers a cached one without a call", async () => {
    const first = requestAlbumCover(1, "grid");
    const again = requestAlbumCover(1, "grid");
    await vi.runAllTimersAsync();
    expect(await first).toBe(await again);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(await requestAlbumCover(1, "grid")).toBe("asset:c1");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("resolves null for an album with no cover and does not cache it", async () => {
    mocked.mockResolvedValueOnce([{ album_id: 7, cover: null }]);
    const result = requestAlbumCover(7, "thumb");
    await vi.runAllTimersAsync();
    expect(await result).toBeNull();
    expect(peekAlbumCover(7, "thumb")).toBeUndefined();
  });

  it("resolves null when the call fails", async () => {
    mocked.mockRejectedValueOnce(new Error("boom"));
    const result = requestAlbumCover(7, "thumb");
    await vi.runAllTimersAsync();
    expect(await result).toBeNull();
  });

  it("invalidation clears every size and bumps the version", async () => {
    for (const size of ["thumb", "grid", "detail"] as const) void requestAlbumCover(1, size);
    await vi.runAllTimersAsync();
    expect(peekAlbumCover(1, "thumb")).toBeDefined();
    expect(peekAlbumCover(1, "grid")).toBeDefined();
    expect(peekAlbumCover(1, "detail")).toBeDefined();

    invalidateAlbumCover(1);
    expect(peekAlbumCover(1, "thumb")).toBeUndefined();
    expect(peekAlbumCover(1, "grid")).toBeUndefined();
    expect(peekAlbumCover(1, "detail")).toBeUndefined();
    expect(albumCoverVersion(1)).toBe(1);
  });

  it("does not cache an answer that lands after its album was invalidated", async () => {
    let release: (v: ReturnType<typeof answer>) => void = () => {};
    mocked.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    void requestAlbumCover(1, "grid");
    await vi.runAllTimersAsync();

    invalidateAlbumCover(1);
    release(answer([1]));
    await vi.runAllTimersAsync();
    expect(peekAlbumCover(1, "grid")).toBeUndefined();

    const fresh = requestAlbumCover(1, "grid");
    await vi.runAllTimersAsync();
    expect(await fresh).toBe("asset:c1");
    expect(mocked).toHaveBeenCalledTimes(2);
  });
});
