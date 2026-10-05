// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Library Imports --
import { createTable, getCoreRowModel, getFilteredRowModel } from "@tanstack/react-table";

// -- Unit Imports --
import { buildFinderIndex } from "./finderIndex";
import { searchFinder } from "./finderMatch";
import { buildAlbumIndex } from "../tracks/trackAlbum";
import { collectionColumns, toColumnDefs, trackGlobalFilter } from "../tracks/trackColumns";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

function track(over: Partial<TrackRow>): TrackRow {
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

function album(over: Partial<AlbumRow>): AlbumRow {
  return {
    id: 1,
    title: null,
    album_artist: null,
    year: null,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function member(albumId: number, trackId: number): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: "",
    filename: "",
    duration_secs: null,
    track_no: null,
    disc_no: null,
    raw_title: null,
    raw_artist: null,
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at: null,
    keep_own_cover: false,
    genre_ids: [],
  };
}

// A small library that exercises every field: an edited title, a filed album overriding its tag, a
// single, an untitled track found by filename, accents, and a track gone from disk.
const tracks: TrackRow[] = [
  track({ id: 1, raw_title: "Wall", raw_artist: "Pink Floyd", raw_album: "Tag", filename: "01 wall.flac" }),
  track({ id: 2, raw_title: "Mother", raw_artist: "Pink Floyd", filename: "02 mother.flac" }),
  track({ id: 3, raw_title: "Raw", title_edit: "\u00c9lo\u00efse", raw_artist: "Arno", filename: "eloise.mp3" }),
  track({ id: 4, raw_artist: "Unknown", filename: "demo take.wav" }),
  track({ id: 5, raw_title: "Wall Of Sound", raw_artist: "Pink", missing_at: 9, filename: "gone.flac" }),
  track({ id: 6, raw_title: "Solo", raw_artist: "Caf\u00e9 Tacvba", filename: "solo.mp3" }),
];
const albums: AlbumRow[] = [
  album({ id: 10, title: "The Wall", album_artist: "Pink Floyd" }),
  album({ id: 11, title: "Solo", kind: "single" }),
];
const membership: AlbumTrackRow[] = [member(10, 1), member(10, 2), member(11, 6)];

function finderCount(query: string): number {
  const index = buildFinderIndex({
    tracks,
    albums,
    membership,
    playlists: [],
    slots: [],
    genres: [],
    untitledAlbum: "Untitled",
    untitledPlaylist: "Untitled playlist",
  });
  return searchFinder([index.entries], query, new Map(), index.goneTrackFields).trackMatches;
}

// The rows All Tracks keeps with its facets and narrowings cleared: the same table the grid builds.
function gridCount(query: string): number {
  const table = createTable<TrackRow>({
    data: tracks,
    columns: toColumnDefs(collectionColumns, buildAlbumIndex(membership, albums)),
    state: {},
    onStateChange: () => {},
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: trackGlobalFilter,
    getColumnCanGlobalFilter: () => true,
  });
  table.setOptions((prev) => ({ ...prev, state: { ...table.initialState, globalFilter: query } }));
  return table.getFilteredRowModel().rows.length;
}

describe("finder and All Tracks search parity", () => {
  const queries = [
    "pink wall",
    "wall pink",
    "wall",
    "the wall",
    "floyd mother",
    "eloise",
    "\u00c9LO",
    "cafe",
    "take",
    "flac",
    "tag",
    "solo",
    "o",
    "zzz",
  ];

  it.each(queries)("counts the same tracks for %j", (query) => {
    expect(finderCount(query)).toBe(gridCount(query));
  });

  it("finds a track by words spread over its title and artist", () => {
    expect(gridCount("pink wall")).toBeGreaterThan(0);
  });
});
