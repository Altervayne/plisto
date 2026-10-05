// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  collectionColumns,
  gridTemplate,
  toColumnDefs,
  trackColumns,
  trackGlobalFilter,
} from "./trackColumns";

// -- Library Imports --
import { createTable, getCoreRowModel, getFilteredRowModel } from "@tanstack/react-table";

// -- Type Imports --
import type { TrackRow } from "../../types";

// A minimal row with only the fields the search reads; the rest carry inert defaults.
function row(over: Partial<TrackRow>): TrackRow {
  return {
    id: 1,
    source_path: "",
    filename: "file.flac",
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

// The ids the All Tracks table keeps for a search, run through the same table setup the grid uses.
function gridMatches(tracks: TrackRow[], query: string): number[] {
  const table = createTable<TrackRow>({
    data: tracks,
    columns: toColumnDefs(collectionColumns),
    state: {},
    onStateChange: () => {},
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: trackGlobalFilter,
    getColumnCanGlobalFilter: () => true,
  });
  table.setOptions((prev) => ({ ...prev, state: { ...table.initialState, globalFilter: query } }));
  return table.getFilteredRowModel().rows.map((r) => r.original.id);
}

describe("collectionColumns", () => {
  it("leads with an affordance-only gutter and no track number", () => {
    const lead = collectionColumns[0];
    expect(lead.affordance).toBe(true);
    // The lead cell carries no value, so it never reads as a real track-number column.
    expect(lead.resolve).toBeUndefined();
    expect(lead.format).toBeUndefined();
  });

  it("drops the source-file columns", () => {
    const ids = collectionColumns.map((c) => c.id);
    expect(ids).not.toContain("filename");
    expect(ids).not.toContain("ext");
  });

  it("keeps the metadata columns in reading order", () => {
    expect(collectionColumns.map((c) => c.id)).toEqual([
      "raw_track_no",
      "raw_title",
      "raw_artist",
      "raw_album",
      "raw_year",
      "duration_secs",
    ]);
  });
});

describe("gridTemplate", () => {
  it("leads with a fixed gutter and flexes the text columns", () => {
    expect(gridTemplate(collectionColumns)).toBe(
      "44px minmax(0, 2fr) minmax(0, 1.4fr) minmax(0, 1.4fr) 60px 72px",
    );
  });

  it("defaults to the file columns when none are passed", () => {
    expect(gridTemplate()).toBe(gridTemplate(trackColumns));
  });
});

describe("toColumnDefs", () => {
  it("leaves the affordance column unsortable and unsearchable", () => {
    const lead = toColumnDefs(collectionColumns)[0];
    expect(lead.enableSorting).toBe(false);
    expect(lead.enableGlobalFilter).toBe(false);
  });

  it("keeps the title sortable and searchable", () => {
    const title = toColumnDefs(collectionColumns).find((d) => d.id === "raw_title");
    expect(title?.enableSorting).toBe(true);
    expect(title?.enableGlobalFilter).toBe(true);
  });
});

describe("trackGlobalFilter", () => {
  it("matches tokens across fields, in any order", () => {
    const tracks = [row({ id: 1, raw_title: "Wall", raw_artist: "Pink Floyd" }), row({ id: 2, raw_title: "Pink" })];
    expect(gridMatches(tracks, "pink wall")).toEqual([1]);
    expect(gridMatches(tracks, "wall pink")).toEqual([1]);
  });

  it("matches across case and accents", () => {
    const tracks = [row({ id: 1, raw_title: "\u00c9lo\u00efse" }), row({ id: 2, raw_artist: "Cafe" })];
    expect(gridMatches(tracks, "ELOISE")).toEqual([1]);
    expect(gridMatches(tracks, "caf\u00e9")).toEqual([2]);
  });

  it("reaches the filename even without its column", () => {
    const tracks = [row({ id: 1, filename: "demo take.flac" }), row({ id: 2 })];
    expect(gridMatches(tracks, "take")).toEqual([1]);
  });

  it("keeps every row for a blank query", () => {
    const tracks = [row({ id: 1 }), row({ id: 2 })];
    expect(gridMatches(tracks, "   ")).toEqual([1, 2]);
  });
});
