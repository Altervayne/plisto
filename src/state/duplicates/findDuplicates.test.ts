// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { findDuplicates } from "./findDuplicates";

// -- Type Imports --
import type { DismissedPair, TrackRow } from "../../types";

// A present row titled "Song" by "Band", the fields a case does not set defaulted.
function track(id: number, tags: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    source_path: `/music/${id}.mp3`,
    filename: `${id}.mp3`,
    ext: "mp3",
    size_bytes: 1000 + id,
    mtime: 1,
    duration_secs: 200,
    raw_title: "Song",
    raw_artist: "Band",
    raw_album: null,
    raw_album_artist: null,
    raw_track_no: null,
    raw_disc_no: null,
    raw_year: null,
    raw_genre: null,
    scanned_at: 1,
    missing_at: null,
    display_path: null,
    title_edit: null,
    artist_edit: null,
    album_edit: null,
    album_artist_edit: null,
    year_edit: null,
    disc_edit: null,
    genre_ids: [],
    ...tags,
  };
}

const pair = (track_lo: number, track_hi: number): DismissedPair => ({ track_lo, track_hi });

const ids = (tracks: TrackRow[], dismissals: DismissedPair[] = []) =>
  findDuplicates(tracks, dismissals).groups.map((g) => g.trackIds);

describe("findDuplicates clustering", () => {
  it("keeps 2.0 s apart together and splits 2.01 s apart", () => {
    expect(ids([track(1, { duration_secs: 200 }), track(2, { duration_secs: 202 })])).toEqual([[1, 2]]);
    expect(ids([track(1, { duration_secs: 200 }), track(2, { duration_secs: 202.01 })])).toEqual([]);
  });

  it("anchors each run on its first copy, not the previous one", () => {
    const tracks = [
      track(1, { duration_secs: 200 }),
      track(2, { duration_secs: 201.5 }),
      track(3, { duration_secs: 203 }),
      track(4, { duration_secs: 204 }),
    ];
    expect(ids(tracks)).toEqual([[1, 2], [3, 4]]);
  });

  it("keeps live and featuring variants apart", () => {
    const tracks = [
      track(1),
      track(2, { raw_title: "Song (Live)" }),
      track(3, { raw_title: "Song feat. Guest" }),
      track(4, { raw_artist: "Band feat. Guest" }),
    ];
    expect(ids(tracks)).toEqual([]);
  });

  it("folds case and spacing in the key", () => {
    expect(ids([track(1), track(2, { raw_title: "  SONG ", raw_artist: "band" })])).toEqual([[1, 2]]);
  });

  it("leaves out a track with no duration", () => {
    expect(ids([track(1), track(2, { duration_secs: null })])).toEqual([]);
  });

  it("leaves out a gone track", () => {
    expect(ids([track(1), track(2, { missing_at: 5 })])).toEqual([]);
  });

  it("leaves out a track with no title or no artist", () => {
    expect(ids([track(1, { raw_title: null }), track(2, { raw_title: null })])).toEqual([]);
    expect(ids([track(1, { raw_artist: null }), track(2, { raw_artist: null })])).toEqual([]);
  });

  it("matches on the edit over the raw tag", () => {
    const tracks = [track(1), track(2, { raw_title: "Untitled 02", title_edit: "Song" })];
    expect(ids(tracks)).toEqual([[1, 2]]);
    expect(ids([track(1), track(2, { title_edit: "Other" })])).toEqual([]);
  });
});

describe("findDuplicates dismissals", () => {
  it("hides a fully dismissed group and returns it for Restore", () => {
    const result = findDuplicates([track(1), track(2)], [pair(1, 2)]);
    expect(result.groups).toEqual([]);
    expect(result.dismissed.map((g) => g.trackIds)).toEqual([[1, 2]]);
  });

  it("splits a group along its dismissed pairs", () => {
    const tracks = [track(1), track(2), track(3), track(4)];
    const dismissals = [pair(1, 3), pair(1, 4), pair(2, 3), pair(2, 4)];
    expect(ids(tracks, dismissals)).toEqual([[1, 2], [3, 4]]);
  });

  it("brings a dismissed group back through a new copy's pairs", () => {
    expect(ids([track(1), track(2), track(3)], [pair(1, 2)])).toEqual([[1, 2, 3]]);
  });

  it("shows only the new pair when the other copies stay dismissed", () => {
    const result = findDuplicates([track(1), track(2), track(3)], [pair(1, 2), pair(1, 3)]);
    expect(result.groups.map((g) => g.trackIds)).toEqual([[2, 3]]);
    expect(result.dismissed).toEqual([]);
  });
});

describe("findDuplicates labels and order", () => {
  it("labels the copies sharing a size and format as identical", () => {
    const tracks = [
      track(1, { size_bytes: 500 }),
      track(2, { size_bytes: 500 }),
      track(3, { size_bytes: 500, ext: "flac" }),
    ];
    const [group] = findDuplicates(tracks, []).groups;
    expect(group.trackIds).toEqual([1, 2, 3]);
    expect(group.identicalIds).toEqual([1, 2]);
  });

  it("names the group from its lowest-id copy", () => {
    const [group] = findDuplicates([track(2, { raw_title: "SONG" }), track(1)], []).groups;
    expect(group.title).toBe("Song");
    expect(group.artist).toBe("Band");
  });

  it("returns the same order whatever order the tracks come in", () => {
    const tracks = [
      track(1, { raw_title: "Beta" }),
      track(2, { raw_title: "Alpha" }),
      track(3, { raw_title: "Beta" }),
      track(4, { raw_title: "Alpha" }),
      track(5, { raw_title: "Alpha", duration_secs: 300 }),
      track(6, { raw_title: "Alpha", duration_secs: 300 }),
    ];
    const forward = findDuplicates(tracks, []).groups.map((g) => g.trackIds);
    const backward = findDuplicates([...tracks].reverse(), []).groups.map((g) => g.trackIds);
    expect(forward).toEqual([[2, 4], [5, 6], [1, 3]]);
    expect(backward).toEqual(forward);
  });
});
