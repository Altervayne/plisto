// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  facetOptions,
  filterByFacets,
  isMissingMetadata,
  resolveFacet,
  toggleFacet,
  trackGenreNames,
} from "./trackFacets";

// -- Unit Imports --
import { buildAlbumIndex } from "./trackAlbum";

// -- Type Imports --
import type { GridFacet } from "./trackFacets";
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

// A minimal row with only the fields the facets read; the rest carry inert defaults.
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

describe("resolveFacet", () => {
  it("prefers the edit over the raw tag", () => {
    const track = row({ raw_artist: "Miles", artist_edit: "Miles Davis" });
    expect(resolveFacet(track, "artist")).toBe("Miles Davis");
  });

  it("falls through to the raw tag when unedited", () => {
    expect(resolveFacet(row({ raw_album: "Kind of Blue" }), "album")).toBe("Kind of Blue");
  });

  it("reads year as a string, edit over raw", () => {
    expect(resolveFacet(row({ raw_year: 1959, year_edit: 1997 }), "year")).toBe("1997");
  });

  it("folds an absent or empty tag to null", () => {
    expect(resolveFacet(row({ raw_artist: null }), "artist")).toBeNull();
    expect(resolveFacet(row({ raw_artist: "" }), "artist")).toBeNull();
  });
});

describe("trackGenreNames", () => {
  it("maps ids through the vocabulary and drops unknowns", () => {
    const track = row({ genre_ids: [2, 99, 1] });
    expect(trackGenreNames(track, genres)).toEqual(["Rock", "Jazz"]);
  });
});

describe("facetOptions", () => {
  it("lists distinct values, years newest first and names sorted", () => {
    const tracks = [
      row({ raw_artist: "B", raw_year: 1990, genre_ids: [1] }),
      row({ raw_artist: "A", raw_year: 2001, genre_ids: [2] }),
      row({ raw_artist: "A", raw_year: 1990, genre_ids: [1] }),
    ];
    const opts = facetOptions(tracks, genres);
    expect(opts.artist).toEqual(["A", "B"]);
    expect(opts.year).toEqual(["2001", "1990"]);
    expect(opts.genre).toEqual(["Jazz", "Rock"]);
  });
});

describe("filterByFacets", () => {
  const tracks = [
    row({ id: 1, raw_artist: "Miles", raw_year: 1959, genre_ids: [1] }),
    row({ id: 2, raw_artist: "Bill", raw_year: 1961, genre_ids: [1] }),
    row({ id: 3, raw_artist: "Miles", raw_year: 1970, genre_ids: [2] }),
  ];

  it("returns every row when no facet is active", () => {
    expect(filterByFacets(tracks, [], genres)).toHaveLength(3);
  });

  it("ORs values within a facet", () => {
    const facets: GridFacet[] = [
      { facet: "artist", value: "Miles" },
      { facet: "artist", value: "Bill" },
    ];
    expect(filterByFacets(tracks, facets, genres).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("ANDs across facets", () => {
    const facets: GridFacet[] = [
      { facet: "artist", value: "Miles" },
      { facet: "genre", value: "Jazz" },
    ];
    expect(filterByFacets(tracks, facets, genres).map((t) => t.id)).toEqual([1]);
  });

  it("matches genre through the vocabulary, not raw_genre", () => {
    const facets: GridFacet[] = [{ facet: "genre", value: "Rock" }];
    expect(filterByFacets(tracks, facets, genres).map((t) => t.id)).toEqual([3]);
  });

  it("matches the resolved value, so an edit filters to its edited value", () => {
    const edited = [row({ id: 4, raw_artist: "Trane", artist_edit: "Coltrane" })];
    const facets: GridFacet[] = [{ facet: "artist", value: "Coltrane" }];
    expect(filterByFacets(edited, facets, genres)).toHaveLength(1);
    expect(filterByFacets(edited, [{ facet: "artist", value: "Trane" }], genres)).toHaveLength(0);
  });
});

describe("isMissingMetadata", () => {
  const tagged = { raw_title: "Blue in Green", raw_artist: "Miles", raw_album: "Kind of Blue" };

  it("is false when title, artist, and album all resolve", () => {
    expect(isMissingMetadata(row(tagged))).toBe(false);
  });

  it("is true when the title is empty", () => {
    expect(isMissingMetadata(row({ ...tagged, raw_title: null }))).toBe(true);
    expect(isMissingMetadata(row({ ...tagged, raw_title: "" }))).toBe(true);
  });

  it("is true when the artist is empty", () => {
    expect(isMissingMetadata(row({ ...tagged, raw_artist: null }))).toBe(true);
  });

  it("is true when the album is empty", () => {
    expect(isMissingMetadata(row({ ...tagged, raw_album: null }))).toBe(true);
  });

  it("reads the edit over the raw tag, so an edit fills a missing field", () => {
    expect(isMissingMetadata(row({ ...tagged, raw_title: null, title_edit: "Untitled cut" }))).toBe(
      false,
    );
  });

  it("composes with the facet pre-filter: facets first, then missing metadata", () => {
    const tracks = [
      row({ id: 1, raw_artist: "Miles", raw_title: "So What", raw_album: "Kind of Blue" }),
      row({ id: 2, raw_artist: "Miles", raw_title: null, raw_album: "Kind of Blue" }),
      row({ id: 3, raw_artist: "Bill", raw_title: null, raw_album: null }),
    ];
    const byFacets = filterByFacets(tracks, [{ facet: "artist", value: "Miles" }], genres);
    expect(byFacets.filter((t) => isMissingMetadata(t)).map((t) => t.id)).toEqual([2]);
  });

  it("clears the album term for a member of a titled album, even with a blank raw tag", () => {
    const track = row({ id: 10, raw_title: "Track", raw_artist: "Band", raw_album: null });
    const index = memberIndex(10, album({ id: 1, title: "Real Album", kind: "album" }));
    expect(isMissingMetadata(track, index)).toBe(false);
  });

  it("flags a member of an untitled album on the album term", () => {
    const track = row({ id: 10, raw_title: "Track", raw_artist: "Band", raw_album: null });
    const index = memberIndex(10, album({ id: 1, title: null, kind: "album" }));
    expect(isMissingMetadata(track, index)).toBe(true);
  });

  it("exempts a single from the album term, even with no album title", () => {
    const track = row({ id: 10, raw_title: "Track", raw_artist: "Band", raw_album: null });
    const index = memberIndex(10, album({ id: 1, title: null, kind: "single" }));
    expect(isMissingMetadata(track, index)).toBe(false);
  });

  it("keeps the loose behavior when the index is empty", () => {
    const loose = row({ ...tagged, raw_album: null });
    expect(isMissingMetadata(loose)).toBe(true);
    expect(isMissingMetadata(row(tagged))).toBe(false);
  });
});

// A minimal album carrying the fields the resolvers read.
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

// A membership row placing one track into one album, only the join keys filled.
function memberRow(albumId: number, trackId: number): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: "",
    filename: "",
    duration_secs: null,
    track_no: 1,
    disc_no: 1,
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

// An index filing one track into one album.
function memberIndex(trackId: number, a: AlbumRow): Map<number, AlbumRow> {
  return buildAlbumIndex([memberRow(a.id, trackId)], [a]);
}

describe("toggleFacet", () => {
  it("adds a chip when absent and drops it when present", () => {
    const added = toggleFacet([], "genre", "Jazz");
    expect(added).toEqual([{ facet: "genre", value: "Jazz" }]);
    expect(toggleFacet(added, "genre", "Jazz")).toEqual([]);
  });
});
