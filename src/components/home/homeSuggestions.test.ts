// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  countMissingMetadata,
  pickPlayNext,
  topArtistFrom,
  tracksByArtist,
} from "./homeSuggestions";

// -- Type Imports --
import type { TrackRow } from "../../types";

/** A track with everything filled, overridden per case so each test states only what it exercises. */
function track(over: Partial<TrackRow>): TrackRow {
  return {
    id: 1,
    source_path: "/m/1.mp3",
    filename: "1.mp3",
    ext: "mp3",
    size_bytes: 0,
    mtime: 0,
    duration_secs: 180,
    raw_title: "Title",
    raw_artist: "Artist",
    raw_album: "Album",
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

describe("countMissingMetadata", () => {
  it("counts a track whose raw title is empty", () => {
    expect(countMissingMetadata([track({ raw_title: null })])).toBe(1);
    expect(countMissingMetadata([track({ raw_title: "" })])).toBe(1);
  });

  it("counts a track whose artist is empty", () => {
    expect(countMissingMetadata([track({ raw_artist: null })])).toBe(1);
  });

  it("counts a track whose album is empty", () => {
    expect(countMissingMetadata([track({ raw_album: null })])).toBe(1);
  });

  it("counts a track only once when several fields are empty", () => {
    expect(countMissingMetadata([track({ raw_title: null, raw_artist: null })])).toBe(1);
  });

  it("reads the edit over the raw: a filled edit rescues an empty raw", () => {
    expect(countMissingMetadata([track({ raw_title: null, title_edit: "Named" })])).toBe(0);
  });

  it("reads the edit over the raw: an empty edit does not clear a filled raw", () => {
    // A null edit falls back to the raw, so a present raw still counts as filled.
    expect(countMissingMetadata([track({ raw_artist: "Real", artist_edit: null })])).toBe(0);
  });

  it("ignores year and track number", () => {
    expect(countMissingMetadata([track({ raw_year: null, raw_track_no: null })])).toBe(0);
  });

  it("tallies across a list", () => {
    expect(
      countMissingMetadata([track({ id: 1 }), track({ id: 2, raw_album: null }), track({ id: 3 })]),
    ).toBe(1);
  });
});

describe("pickPlayNext", () => {
  const seed = track({ id: 10, raw_artist: "Band" });

  it("suggests the first playable track after the seed in its album, named by the album", () => {
    const album = [seed, track({ id: 11, raw_album: "Record" }), track({ id: 12 })];
    const next = pickPlayNext(seed, album, [], []);
    expect(next?.track.id).toBe(11);
    // The album name comes from the seed's resolved album, not the picked track's.
    expect(next?.reason).toEqual({ kind: "album", album: "Album" });
  });

  it("skips a missing-source track when walking the album", () => {
    const album = [seed, track({ id: 11, missing_at: 1 }), track({ id: 12 })];
    expect(pickPlayNext(seed, album, [], [])?.track.id).toBe(12);
  });

  it("falls to another artist track when the seed is loose, named by the artist", () => {
    const artist = [track({ id: 20, raw_artist: "Band" }), track({ id: 21, raw_artist: "Band" })];
    const next = pickPlayNext(seed, [], artist, []);
    expect(next?.track.id).toBe(20);
    expect(next?.reason).toEqual({ kind: "artist", artist: "Band" });
  });

  it("falls to the artist branch when the seed ends its album", () => {
    const album = [track({ id: 9 }), seed];
    const artist = [track({ id: 20, raw_artist: "Band" })];
    expect(pickPlayNext(seed, album, artist, [])?.track.id).toBe(20);
  });

  it("skips the seed and recently-played rows in the artist branch", () => {
    const artist = [
      track({ id: 10, raw_artist: "Band" }),
      track({ id: 21, raw_artist: "Band" }),
      track({ id: 22, raw_artist: "Band" }),
    ];
    expect(pickPlayNext(seed, [], artist, [21])?.track.id).toBe(22);
  });

  it("skips a missing-source artist candidate", () => {
    const artist = [
      track({ id: 20, raw_artist: "Band", missing_at: 1 }),
      track({ id: 21, raw_artist: "Band" }),
    ];
    expect(pickPlayNext(seed, [], artist, [])?.track.id).toBe(21);
  });

  it("returns nothing when no album-next and no artist candidate remain", () => {
    expect(pickPlayNext(seed, [seed], [], [])).toBeNull();
  });
});

describe("topArtistFrom", () => {
  it("reads the resolved artist of the first row", () => {
    expect(topArtistFrom([track({ raw_artist: "Band" })])).toBe("Band");
  });

  it("prefers the edit over the raw", () => {
    expect(topArtistFrom([track({ raw_artist: "Raw", artist_edit: "Edited" })])).toBe("Edited");
  });

  it("is null on a cold play-log", () => {
    expect(topArtistFrom([])).toBeNull();
  });

  it("is null when the top row has no artist", () => {
    expect(topArtistFrom([track({ raw_artist: null })])).toBeNull();
  });
});

describe("tracksByArtist", () => {
  const tracks = [
    track({ id: 1, raw_artist: "Band" }),
    track({ id: 2, raw_artist: "Other" }),
    track({ id: 3, raw_artist: "Band" }),
    track({ id: 4, raw_artist: "Band", missing_at: 1 }),
    track({ id: 5, raw_artist: "Band" }),
  ];

  it("keeps only the artist's playable tracks, in index order", () => {
    expect(tracksByArtist(tracks, "Band", 10).map((t) => t.id)).toEqual([1, 3, 5]);
  });

  it("caps at the limit", () => {
    expect(tracksByArtist(tracks, "Band", 2).map((t) => t.id)).toEqual([1, 3]);
  });

  it("drops excluded ids", () => {
    expect(tracksByArtist(tracks, "Band", 10, [1]).map((t) => t.id)).toEqual([3, 5]);
  });

  it("resolves the artist edit over the raw", () => {
    const edited = [track({ id: 6, raw_artist: "Raw", artist_edit: "Band" })];
    expect(tracksByArtist(edited, "Band", 10).map((t) => t.id)).toEqual([6]);
  });
});
