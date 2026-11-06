// -- Library Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- IPC Imports --
import { albumCovers } from "../../lib/ipc";

// -- Utils Imports --
import { requestAlbumCover, resetAlbumCoverBatch } from "./albumCoverBatch";
import { initialAlbumCover } from "./useAlbumCover";

vi.mock("../../lib/ipc", () => ({ albumCovers: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset:${p}` }));

describe("initialAlbumCover", () => {
  beforeEach(() => {
    resetAlbumCoverBatch();
    vi.mocked(albumCovers).mockReset();
  });

  it("starts loading on a cache miss", () => {
    expect(initialAlbumCover(1, "grid")).toEqual({ src: null, loading: true });
  });

  it("paints a cached cover at once, not loading", async () => {
    vi.mocked(albumCovers).mockResolvedValue([
      { album_id: 1, cover: { path: "c1", width: 1, height: 1, source: "embedded" } },
    ]);
    await requestAlbumCover(1, "grid");
    expect(initialAlbumCover(1, "grid")).toEqual({ src: "asset:c1", loading: false });
    expect(initialAlbumCover(1, "detail")).toEqual({ src: null, loading: true });
  });
});
