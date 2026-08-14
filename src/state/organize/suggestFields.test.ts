// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { suggestAlbumFields } from "./suggestFields";

// -- Type Imports --
import type { TrackRow } from "../../types";

// A scanned row with the columns a suggestion does not read defaulted, the raw tags set per case.
function track(id: number, raw: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    source_path: `/m/${id}.mp3`,
    filename: `${id}.mp3`,
    ext: "mp3",
    size_bytes: 1,
    mtime: 1,
    duration_secs: 100,
    raw_title: `title ${id}`,
    raw_artist: null,
    raw_album: null,
    raw_album_artist: null,
    raw_track_no: null,
    raw_disc_no: null,
    raw_year: null,
    raw_genre: null,
    scanned_at: 1,
    missing_at: null,
    display_path: `/m/${id}.mp3`,
    ...raw,
  };
}

describe("suggestAlbumFields", () => {
  it("takes the shared values from a clean selection", () => {
    const tracks = [
      track(1, { raw_album: "Blue", raw_album_artist: "Joni", raw_year: 1971, raw_genre: "Folk" }),
      track(2, { raw_album: "Blue", raw_album_artist: "Joni", raw_year: 1971, raw_genre: "Folk" }),
      track(3, { raw_album: "Blue", raw_album_artist: "Joni", raw_year: 1971, raw_genre: "Folk" }),
    ];
    expect(suggestAlbumFields(tracks)).toEqual({
      title: "Blue",
      album_artist: "Joni",
      year: 1971,
      genre: "Folk",
    });
  });

  it("takes the most common value from a mixed selection", () => {
    const tracks = [
      track(1, { raw_album: "Blue", raw_year: 1971 }),
      track(2, { raw_album: "Blue", raw_year: 1971 }),
      track(3, { raw_album: "Clouds", raw_year: 1969 }),
    ];
    const fields = suggestAlbumFields(tracks);
    expect(fields.title).toBe("Blue");
    expect(fields.year).toBe(1971);
  });

  it("falls back to the artist tag when no album artist is set", () => {
    const tracks = [
      track(1, { raw_artist: "Joni Mitchell" }),
      track(2, { raw_artist: "Joni Mitchell" }),
    ];
    expect(suggestAlbumFields(tracks).album_artist).toBe("Joni Mitchell");
  });

  it("yields all-null when every raw tag is absent", () => {
    const tracks = [track(1), track(2)];
    expect(suggestAlbumFields(tracks)).toEqual({
      title: null,
      album_artist: null,
      year: null,
      genre: null,
    });
  });

  it("breaks a tie on first appearance", () => {
    const tracks = [
      track(1, { raw_genre: "Jazz" }),
      track(2, { raw_genre: "Folk" }),
    ];
    expect(suggestAlbumFields(tracks).genre).toBe("Jazz");
  });
});
