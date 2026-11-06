// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { recordLabel } from "./browseRecord";

// -- Type Imports --
import type { AlbumRow } from "../../../types";

const album = (over: Partial<AlbumRow>): AlbumRow => ({
  id: 1,
  title: "Undertow",
  album_artist: "Glass Harbor",
  year: 2023,
  genre: null,
  cover_id: null,
  kind: "album",
  track_count: 10,
  created_at: 0,
  updated_at: 0,
  ...over,
});

describe("recordLabel", () => {
  it("reads title, artist and year", () => {
    expect(recordLabel(album({}), "Untitled")).toBe("Undertow, Glass Harbor, 2023");
  });

  it("skips what the album lacks and names an untitled one", () => {
    expect(recordLabel(album({ title: null, album_artist: null, year: null }), "Untitled")).toBe(
      "Untitled",
    );
    expect(recordLabel(album({ album_artist: "", year: null }), "Untitled")).toBe("Undertow");
  });
});
