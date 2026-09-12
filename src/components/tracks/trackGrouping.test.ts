// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { UNTAGGED_KEY, flattenGroups, groupRows } from "./trackGrouping";

// -- Type Imports --
import type { TrackRow } from "../../types";

// A minimal row with only the fields the grouping reads; the rest carry inert defaults.
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

const genres = new Map<number, string>([
  [1, "Jazz"],
  [2, "Rock"],
  [3, "Ambient"],
]);

describe("groupRows", () => {
  it("buckets by a single-tag facet, preserving row order within a group", () => {
    const rows = [
      row({ id: 1, raw_artist: "Miles" }),
      row({ id: 2, raw_artist: "Bill" }),
      row({ id: 3, raw_artist: "Miles" }),
    ];
    const groups = groupRows(rows, "artist", genres);
    expect(groups.map((g) => g.key)).toEqual(["Bill", "Miles"]);
    expect(groups.find((g) => g.key === "Miles")?.rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it("places a multi-genre track under each of its genres", () => {
    const rows = [row({ id: 1, genre_ids: [1, 2] }), row({ id: 2, genre_ids: [2] })];
    const groups = groupRows(rows, "genre", genres);
    expect(groups.map((g) => g.key)).toEqual(["Jazz", "Rock"]);
    expect(groups.find((g) => g.key === "Jazz")?.rows.map((r) => r.id)).toEqual([1]);
    expect(groups.find((g) => g.key === "Rock")?.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("collects rows with no value into an untagged bucket that sorts last", () => {
    const rows = [
      row({ id: 1, raw_album: "Blue" }),
      row({ id: 2, raw_album: null }),
      row({ id: 3, raw_album: "Aja" }),
    ];
    const groups = groupRows(rows, "album", genres);
    expect(groups.map((g) => g.key)).toEqual(["Aja", "Blue", UNTAGGED_KEY]);
    expect(groups[2].label).toBe("");
    expect(groups[2].rows.map((r) => r.id)).toEqual([2]);
  });

  it("puts the untagged genre bucket last as well", () => {
    const rows = [row({ id: 1, genre_ids: [2] }), row({ id: 2, genre_ids: [] })];
    const groups = groupRows(rows, "genre", genres);
    expect(groups.map((g) => g.key)).toEqual(["Rock", UNTAGGED_KEY]);
    expect(groups[1].rows.map((r) => r.id)).toEqual([2]);
  });

  it("orders year buckets newest first", () => {
    const rows = [row({ raw_year: 1990 }), row({ raw_year: 2001 }), row({ raw_year: 1975 })];
    const groups = groupRows(rows, "year", genres);
    expect(groups.map((g) => g.key)).toEqual(["2001", "1990", "1975"]);
  });

  it("orders name buckets alphabetically, case-insensitive", () => {
    const rows = [row({ raw_artist: "beck" }), row({ raw_artist: "ABBA" }), row({ raw_artist: "Cash" })];
    const groups = groupRows(rows, "artist", genres);
    expect(groups.map((g) => g.key)).toEqual(["ABBA", "beck", "Cash"]);
  });
});

describe("flattenGroups", () => {
  const groups = groupRows(
    [row({ id: 1, raw_artist: "Miles" }), row({ id: 2, raw_artist: "Bill" })],
    "artist",
    genres,
  );

  it("emits each header followed by its rows when nothing is collapsed", () => {
    const items = flattenGroups(groups, new Set());
    expect(items.map((i) => i.type)).toEqual(["header", "row", "header", "row"]);
  });

  it("drops a collapsed group's rows, keeping its header", () => {
    const items = flattenGroups(groups, new Set(["Bill"]));
    expect(items).toHaveLength(3);
    const bill = items.filter((i) => i.type === "row" && i.groupKey === "Bill");
    expect(bill).toHaveLength(0);
    // The Bill header still shows even with its rows hidden.
    expect(items.some((i) => i.type === "header" && i.group.key === "Bill")).toBe(true);
  });
});
