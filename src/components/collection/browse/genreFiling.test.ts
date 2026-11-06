// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { genreFiling } from "./genreFiling";

// -- Type Imports --
import type { AlbumTrackRow, GenreRow } from "../../../types";

const GENRES: GenreRow[] = [
  { id: 1, name: "Rock", track_count: 0 },
  { id: 2, name: "Jazz", track_count: 0 },
  { id: 3, name: "Ambient", track_count: 0 },
];

function member(trackId: number, genreIds: number[]): AlbumTrackRow {
  return {
    album_id: 1,
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

describe("genreFiling", () => {
  it("files under the genre on the most tracks and lists the rest, most first", () => {
    const tracks = [member(1, [1]), member(2, [1]), member(3, [1, 2]), member(4, [3]), member(5, [2])];
    expect(genreFiling(tracks, GENRES)).toEqual({
      genre: "Rock",
      count: 3,
      total: 5,
      tied: [],
      others: [
        { name: "Jazz", count: 2 },
        { name: "Ambient", count: 1 },
      ],
    });
  });

  it("names the genres a tie went against, the first alphabetically filing", () => {
    const tracks = [member(1, [1]), member(2, [2]), member(3, [3])];
    const filing = genreFiling(tracks, GENRES);
    expect(filing?.genre).toBe("Ambient");
    expect(filing?.tied).toEqual(["Jazz", "Rock"]);
  });

  it("has no filing when no track carries a known genre", () => {
    expect(genreFiling([member(1, []), member(2, [9])], GENRES)).toBeNull();
  });
});
