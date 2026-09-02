// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { snapshotQueueMeta } from "./queueMeta";

// -- Type Imports --
import type { TrackRow } from "../../types";

// A bare track row: only the fields the resolver reads carry meaning, the rest are inert defaults.
function row(over: Partial<TrackRow> & { id: number }): TrackRow {
  return {
    source_path: `/m/${over.id}.mp3`,
    filename: `${over.id}.mp3`,
    ext: "mp3",
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

describe("snapshotQueueMeta", () => {
  it("prefers the edit layer over the raw tag", () => {
    const rows = [row({ id: 1, raw_title: "Raw", title_edit: "Edit", raw_artist: "RA", artist_edit: "EA" })];
    expect(snapshotQueueMeta([1], rows)[1]).toEqual({
      title: "Edit",
      artist: "EA",
      durationSecs: null,
    });
  });

  it("falls back to the raw tag when there is no edit", () => {
    const rows = [row({ id: 2, raw_title: "Raw", raw_artist: "RawArt", duration_secs: 90 })];
    expect(snapshotQueueMeta([2], rows)[2]).toEqual({
      title: "Raw",
      artist: "RawArt",
      durationSecs: 90,
    });
  });

  it("falls back to the filename for a title with no tag, and leaves artist null", () => {
    const rows = [row({ id: 3, filename: "song.mp3" })];
    expect(snapshotQueueMeta([3], rows)[3]).toEqual({
      title: "song.mp3",
      artist: null,
      durationSecs: null,
    });
  });

  it("yields an empty placeholder for an id with no row", () => {
    expect(snapshotQueueMeta([9], [])[9]).toEqual({
      title: "",
      artist: null,
      durationSecs: null,
    });
  });

  it("keys every requested id, resolving each from the rows on hand", () => {
    const rows = [row({ id: 1, raw_title: "One" }), row({ id: 2, raw_title: "Two" })];
    const meta = snapshotQueueMeta([2, 1, 2], rows);
    expect(Object.keys(meta).sort()).toEqual(["1", "2"]);
    expect(meta[1].title).toBe("One");
    expect(meta[2].title).toBe("Two");
  });
});
