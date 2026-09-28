// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { planAssign } from "./assignPlan";
import { applyCommand, invertCommand } from "./orgCommands";
import type { OrgState, Placement } from "./orgCommands";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

function row(albumId: number, trackId: number, trackNo: number, discNo: number | null): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: `/m/${trackId}.mp3`,
    filename: `${trackId}.mp3`,
    duration_secs: 100,
    track_no: trackNo,
    disc_no: discNo,
    raw_title: `raw ${trackId}`,
    raw_artist: "raw artist",
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at: null,
    keep_own_cover: false,
    genre_ids: [],
  };
}

function track(id: number, tags: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    source_path: `/m/loose/${id}.mp3`,
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

function album(id: number, trackCount: number): AlbumRow {
  return {
    id,
    title: `Album ${id}`,
    album_artist: null,
    year: null,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: trackCount,
    created_at: 1,
    updated_at: 1,
  };
}

// Album 1 holds disc 1 = 1..3 and disc 2 = 1..2; album 2 holds three disc-2 tracks.
function fixture(): OrgState {
  return {
    albums: [album(1, 5), album(2, 3)],
    membership: [
      row(1, 10, 1, 1),
      row(1, 11, 2, null),
      row(1, 12, 3, 1),
      row(1, 13, 1, 2),
      row(1, 14, 2, 2),
      row(2, 20, 1, 2),
      row(2, 21, 2, 2),
      row(2, 22, 3, 2),
    ],
  };
}

// Each assigned track as [track_id, disc_no, track_no].
const landing = (after: Placement[]): (number | null)[][] =>
  after.flatMap((p) => (p.assigned ? [[p.row.track_id, p.row.disc_no, p.row.track_no]] : []));

describe("planAssign", () => {
  it("appends each loose track after the top of its own disc", () => {
    const tracks = [track(30, { raw_disc_no: 2 }), track(31), track(32, { raw_disc_no: 1, disc_edit: 3 })];
    const cmd = planAssign(fixture().membership, tracks, 1, [30, 31, 32])!;
    expect(landing(cmd.after)).toEqual([
      [30, 2, 3],
      [31, null, 4],
      [32, 3, 1],
    ]);
  });

  it("numbers consecutive tracks on the same disc in the given order", () => {
    const tracks = [track(30, { raw_disc_no: 2 }), track(31, { raw_disc_no: 2 })];
    const cmd = planAssign(fixture().membership, tracks, 1, [31, 30])!;
    expect(landing(cmd.after)).toEqual([
      [31, 2, 3],
      [30, 2, 4],
    ]);
  });

  it("keeps a moving track's disc and numbers it on that disc in the target", () => {
    const cmd = planAssign(fixture().membership, [], 1, [21])!;
    expect(landing(cmd.after)).toEqual([[21, 2, 3]]);
    expect(cmd.before).toEqual([{ assigned: true, row: row(2, 21, 2, 2) }]);
  });

  it("carries a moving track's edits and keep-own-cover flag", () => {
    const start = fixture();
    const edited = { ...row(2, 21, 2, 2), title_override: "Edited", artist_override: "Someone", keep_own_cover: true };
    const membership = start.membership.map((r) => (r.track_id === 21 ? edited : r));
    const [placement] = planAssign(membership, [], 1, [21])!.after;
    expect(placement).toEqual({
      assigned: true,
      row: { ...edited, album_id: 1, track_no: 3 },
    });
  });

  it("projects a loose track's own edits and genres on the container cover", () => {
    const loose = track(30, { title_edit: "Edited", artist_edit: "Someone", genre_ids: [4, 2] });
    const [placement] = planAssign(fixture().membership, [loose], 1, [30])!.after;
    expect(placement.assigned && placement.row).toMatchObject({
      title_override: "Edited",
      artist_override: "Someone",
      genre_ids: [4, 2],
      keep_own_cover: false,
    });
  });

  it("skips a track already in the album and an unknown loose id", () => {
    expect(planAssign(fixture().membership, [], 1, [10, 99])).toBeNull();
  });

  it("undoes a mixed assign back to the exact prior projection", () => {
    const start = fixture();
    const cmd = planAssign(start.membership, [track(30, { raw_disc_no: 2 })], 1, [30, 21])!;
    const assigned = applyCommand(start, cmd);
    expect(assigned.albums.map((a) => a.track_count)).toEqual([7, 2]);

    const undone = applyCommand(assigned, invertCommand(cmd));
    expect(undone).toEqual(start);
    expect(applyCommand(undone, cmd)).toEqual(assigned);
  });
});
