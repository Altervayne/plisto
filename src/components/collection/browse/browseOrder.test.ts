import { describe, expect, it } from "vitest";

import type { AlbumRow, AlbumTrackRow, GenreRow } from "../../../types";
import { browseOrder, primaryGenre, recentBucket } from "./browseOrder";
import type { BrowseBy, BrowseKinds } from "./browseOrder";

const NOW = Date.UTC(2026, 10, 6) / 1000;
const DAY = 86400;
const BOTH: BrowseKinds = { albums: true, singles: true };

function album(over: Partial<AlbumRow>): AlbumRow {
  return {
    id: 1,
    title: "T",
    album_artist: "A",
    year: 2000,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: 1,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function member(albumId: number, trackId: number, genreIds: number[]): AlbumTrackRow {
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
    genre_ids: genreIds,
  };
}

const GENRES: GenreRow[] = [
  { id: 1, name: "Rock", track_count: 0 },
  { id: 2, name: "Jazz", track_count: 0 },
  { id: 3, name: "Ambient", track_count: 0 },
];

function order(albums: AlbumRow[], by: BrowseBy, membership: AlbumTrackRow[] = [], kinds = BOTH) {
  return browseOrder({ albums, membership, genres: GENRES, by, kinds, now: NOW });
}

const titles = (o: { items: AlbumRow[] }) => o.items.map((a) => a.title);

describe("browseOrder none", () => {
  const albums = [
    album({ id: 1, title: "The Zebra" }),
    album({ id: 2, title: "apple" }),
    album({ id: 3, title: "Ecole" }),
    album({ id: 4, title: "42" }),
  ];

  it("sorts by title without the article, digits first", () => {
    expect(titles(order(albums, "none"))).toEqual(["42", "apple", "Ecole", "The Zebra"]);
  });

  it("has no groups and letter rail buckets", () => {
    const o = order(albums, "none");
    expect(o.groups).toEqual([]);
    expect(Array.from(o.groupOf)).toEqual([0, 0, 0, 0]);
    expect(o.letters).toBe(true);
    expect(o.rail).toEqual([
      { key: "#", index: 0, label: null },
      { key: "A", index: 1, label: null },
      { key: "E", index: 2, label: null },
      { key: "Z", index: 3, label: null },
    ]);
    expect(o.railKey).toEqual(["#", "A", "E", "Z"]);
  });
});

describe("browseOrder artist", () => {
  const albums = [
    album({ id: 1, title: "B", album_artist: "The Beta", year: 2005 }),
    album({ id: 2, title: "A", album_artist: "alpha", year: 2010 }),
    album({ id: 3, title: "C", album_artist: "Alpha", year: 2001 }),
    album({ id: 4, title: "D", album_artist: null }),
  ];

  it("groups by artist, folding case, oldest first, unknown last", () => {
    const o = order(albums, "artist");
    expect(titles(o)).toEqual(["C", "A", "B", "D"]);
    expect(o.groups).toEqual([
      { label: { kind: "artist", value: "Alpha" }, start: 0 },
      { label: { kind: "artist", value: "The Beta" }, start: 2 },
      { label: { kind: "unknownArtist" }, start: 3 },
    ]);
    expect(Array.from(o.groupOf)).toEqual([0, 0, 1, 2]);
    expect(o.railKey).toEqual(["A", "A", "B", "#"]);
    expect(o.rail.map((r) => r.key)).toEqual(["A", "B", "#"]);
  });
});

describe("primary genre", () => {
  it("picks the most common", () => {
    expect(primaryGenre(new Map([["Rock", 1], ["Jazz", 3]]))).toBe("Jazz");
  });

  it("breaks a tie to the first alphabetically", () => {
    expect(primaryGenre(new Map([["Rock", 2], ["Jazz", 2], ["Ambient", 1]]))).toBe("Jazz");
    expect(primaryGenre(new Map([["jazz", 2], ["Ambient", 2]]))).toBe("Ambient");
  });

  it("is null for no genres", () => {
    expect(primaryGenre(new Map())).toBeNull();
  });
});

describe("browseOrder genre", () => {
  const albums = [
    album({ id: 1, title: "One", album_artist: "Zed" }),
    album({ id: 2, title: "Two", album_artist: "Yan" }),
    album({ id: 3, title: "Three", album_artist: "Xi" }),
    album({ id: 4, title: "Four", album_artist: "Wu" }),
  ];
  const membership = [
    member(1, 10, [1]),
    member(1, 11, [1, 2]),
    member(1, 12, [2]),
    member(2, 20, [3]),
    member(3, 30, [2]),
    member(3, 31, [99]),
  ];

  it("files each album under its primary genre, ungenred last", () => {
    const o = order(albums, "genre", membership);
    expect(titles(o)).toEqual(["Two", "Three", "One", "Four"]);
    expect(o.groups.map((g) => g.label)).toEqual([
      { kind: "genre", value: "Ambient" },
      { kind: "genre", value: "Jazz" },
      { kind: "noGenre" },
    ]);
  });

  it("applies the tie rule to a tied album", () => {
    const o = order(albums, "genre", membership);
    const one = o.groups[o.groupOf[o.offsetOf(1)!]].label;
    expect(one).toEqual({ kind: "genre", value: "Jazz" });
  });

  it("uses group names on the rail", () => {
    const o = order(albums, "genre", membership);
    expect(o.letters).toBe(false);
    expect(o.rail.map((r) => r.index)).toEqual(o.groups.map((g) => g.start));
    expect(o.rail[2].label).toEqual({ kind: "noGenre" });
  });
});

describe("browseOrder year", () => {
  const albums = [
    album({ id: 1, title: "A", year: 1994 }),
    album({ id: 2, title: "B", year: 1999 }),
    album({ id: 3, title: "C", year: 2000 }),
    album({ id: 4, title: "D", year: null }),
    album({ id: 5, title: "E", year: 1989 }),
  ];

  it("buckets by decade, newest first, undated last", () => {
    const o = order(albums, "year");
    expect(titles(o)).toEqual(["C", "B", "A", "E", "D"]);
    expect(o.groups).toEqual([
      { label: { kind: "decade", value: 2000 }, start: 0 },
      { label: { kind: "decade", value: 1990 }, start: 1 },
      { label: { kind: "decade", value: 1980 }, start: 3 },
      { label: { kind: "noYear" }, start: 4 },
    ]);
  });
});

describe("recentBucket", () => {
  it("cuts at the week and month edges", () => {
    expect(recentBucket(NOW - 6 * DAY, NOW)).toEqual({ span: "week" });
    expect(recentBucket(NOW - 7 * DAY, NOW)).toEqual({ span: "month" });
    expect(recentBucket(NOW - 29 * DAY, NOW)).toEqual({ span: "month" });
    expect(recentBucket(NOW - 30 * DAY, NOW)).toEqual({ span: "thisYear" });
  });

  it("rolls into calendar years and then before", () => {
    expect(recentBucket(Date.UTC(2025, 5, 1) / 1000, NOW)).toEqual({ span: "year", year: 2025 });
    expect(recentBucket(Date.UTC(2024, 0, 1) / 1000, NOW)).toEqual({ span: "year", year: 2024 });
    expect(recentBucket(Date.UTC(2023, 11, 31) / 1000, NOW)).toEqual({ span: "before", year: 2024 });
  });

  it("treats a future stamp as this week", () => {
    expect(recentBucket(NOW + 5 * DAY, NOW)).toEqual({ span: "week" });
  });
});

describe("browseOrder recent", () => {
  it("orders newest first and groups by bucket", () => {
    const albums = [
      album({ id: 1, title: "Old", created_at: Date.UTC(2020, 0, 1) / 1000 }),
      album({ id: 2, title: "New", created_at: NOW - DAY }),
      album({ id: 3, title: "Mid", created_at: NOW - 10 * DAY }),
      album({ id: 4, title: "Newer", created_at: NOW - 60 }),
    ];
    const o = order(albums, "recent");
    expect(titles(o)).toEqual(["Newer", "New", "Mid", "Old"]);
    expect(o.groups.map((g) => g.label)).toEqual([
      { kind: "recent", bucket: { span: "week" } },
      { kind: "recent", bucket: { span: "month" } },
      { kind: "recent", bucket: { span: "before", year: 2024 } },
    ]);
    expect(o.groups.map((g) => g.start)).toEqual([0, 2, 3]);
  });
});

describe("kind chips", () => {
  const albums = [
    album({ id: 1, title: "A", kind: "album" }),
    album({ id: 2, title: "B", kind: "single" }),
    album({ id: 3, title: "C", kind: "album" }),
  ];

  it("filters albums and singles", () => {
    expect(titles(order(albums, "none", [], { albums: true, singles: false }))).toEqual(["A", "C"]);
    expect(titles(order(albums, "none", [], { albums: false, singles: true }))).toEqual(["B"]);
    expect(order(albums, "none", [], { albums: false, singles: false }).items).toEqual([]);
  });

  it("offsetOf follows the filter", () => {
    const o = order(albums, "none", [], { albums: true, singles: false });
    expect(o.offsetOf(3)).toBe(1);
    expect(o.offsetOf(2)).toBeNull();
  });
});

describe("offsetOf", () => {
  const albums = [album({ id: 7, title: "B" }), album({ id: 8, title: "A" })];

  it("finds a present id in the grouped order", () => {
    expect(order(albums, "none").offsetOf(7)).toBe(1);
    expect(order(albums, "none").offsetOf(8)).toBe(0);
  });

  it("is null for an absent id", () => {
    expect(order(albums, "none").offsetOf(99)).toBeNull();
  });
});

describe("empty library", () => {
  it("returns an empty order for every grouping", () => {
    for (const by of ["none", "artist", "genre", "year", "recent"] as BrowseBy[]) {
      const o = order([], by);
      expect(o.items).toEqual([]);
      expect(o.groups).toEqual([]);
      expect(o.rail).toEqual([]);
    }
  });
});
