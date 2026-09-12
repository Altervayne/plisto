// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { chunk, columnCount, flattenCardGroups } from "./trackCardLayout";
import { groupRows } from "./trackGrouping";

// -- Type Imports --
import type { TrackRow } from "../../types";

// A minimal row with only the fields the layout reads; the rest carry inert defaults.
function row(over: Partial<TrackRow>): TrackRow {
  return {
    id: 1,
    source_path: "",
    filename: "",
    ext: "flac",
    size_bytes: 0,
    mtime: 0,
    duration_secs: null,
    raw_title: null,
    raw_artist: null,
    raw_album: null,
    raw_album_artist: null,
    raw_track_no: null,
    raw_disc_no: null,
    raw_year: null,
    raw_genre: null,
    scanned_at: 0,
    missing_at: null,
    display_path: null,
    title_edit: null,
    artist_edit: null,
    album_edit: null,
    album_artist_edit: null,
    year_edit: null,
    disc_edit: null,
    genre_ids: [],
    ...over,
  };
}

const genres = new Map<number, string>();

describe("columnCount", () => {
  it("fits as many tiles plus their gutters as the width holds", () => {
    // Four 168px tiles with 20px gutters need 168*4 + 20*3 = 732.
    expect(columnCount(732, 168, 20)).toBe(4);
    expect(columnCount(731, 168, 20)).toBe(3);
  });

  it("never drops below one column, even under a tile width or at zero", () => {
    expect(columnCount(100, 168, 20)).toBe(1);
    expect(columnCount(0, 168, 20)).toBe(1);
  });
});

describe("chunk", () => {
  it("splits into runs of the given size, preserving order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns no runs for an empty list", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("collapses a non-positive size to single-item runs", () => {
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("flattenCardGroups", () => {
  const groups = groupRows(
    [
      row({ id: 1, raw_artist: "Bill" }),
      row({ id: 2, raw_artist: "Bill" }),
      row({ id: 3, raw_artist: "Bill" }),
      row({ id: 4, raw_artist: "Miles" }),
    ],
    "artist",
    genres,
  );

  it("emits a header then the group's rows chunked into card-rows of cols tiles", () => {
    const items = flattenCardGroups(groups, new Set(), 2);
    expect(items.map((i) => i.type)).toEqual([
      "header",
      "cardRow",
      "cardRow",
      "header",
      "cardRow",
    ]);
    // Bill's three rows chunk into a full pair then a remainder of one.
    const billRows = items.filter((i) => i.type === "cardRow" && i.groupKey === "Bill");
    expect(billRows.map((i) => (i.type === "cardRow" ? i.tracks.map((t) => t.id) : []))).toEqual([
      [1, 2],
      [3],
    ]);
  });

  it("numbers card-rows within their group so a key survives a collapse above", () => {
    const items = flattenCardGroups(groups, new Set(), 2);
    const billRows = items.filter((i) => i.type === "cardRow" && i.groupKey === "Bill");
    expect(billRows.map((i) => (i.type === "cardRow" ? i.row : -1))).toEqual([0, 1]);
  });

  it("drops a collapsed group's card-rows, keeping its header", () => {
    const items = flattenCardGroups(groups, new Set(["Bill"]), 2);
    expect(items.filter((i) => i.type === "cardRow" && i.groupKey === "Bill")).toHaveLength(0);
    expect(items.some((i) => i.type === "header" && i.group.key === "Bill")).toBe(true);
  });
});
