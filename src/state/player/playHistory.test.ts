// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { resolveTrackRows } from "./playHistory";

// -- Type Imports --
import type { TrackRow } from "../../types";

// A minimal row carrying only the id the resolve reads; the rest take inert defaults.
function row(id: number): TrackRow {
  return {
    id,
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
  };
}

describe("resolveTrackRows", () => {
  const tracks = [row(1), row(2), row(3)];

  it("maps ids to rows in the id order, not the index order", () => {
    expect(resolveTrackRows([3, 1], tracks).map((r) => r.id)).toEqual([3, 1]);
  });

  it("drops an id the index no longer carries", () => {
    expect(resolveTrackRows([2, 99, 1], tracks).map((r) => r.id)).toEqual([2, 1]);
  });

  it("returns nothing for a cold empty result", () => {
    expect(resolveTrackRows([], tracks)).toEqual([]);
  });
});
