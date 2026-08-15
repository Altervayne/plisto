// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { applyCommand, invertCommand } from "./orgCommands";
import type { Command, OrgState, Placement } from "./orgCommands";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow } from "../../types";

// A membership row with the track-level fields a fixture does not care about defaulted.
function row(albumId: number, trackId: number, trackNo: number, over: Partial<AlbumTrackRow> = {}): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: `/m/${trackId}.mp3`,
    filename: `${trackId}.mp3`,
    duration_secs: 100,
    track_no: trackNo,
    disc_no: 1,
    raw_title: `raw ${trackId}`,
    raw_artist: "raw artist",
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at: null,
    keep_own_cover: false,
    genre_ids: [],
    ...over,
  };
}

function album(id: number, trackCount: number, over: Partial<AlbumRow> = {}): AlbumRow {
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
    ...over,
  };
}

// Album A (id 1) holds tracks 10, 11; album B (id 2) holds track 20.
function fixture(): OrgState {
  return {
    albums: [album(1, 2), album(2, 1)],
    membership: [row(1, 10, 1), row(1, 11, 2), row(2, 20, 1)],
  };
}

// Rebuilds the exact assign command the store would build for moving one track into an album.
function moveCommand(state: OrgState, albumId: number, trackId: number): Command {
  const current = state.membership.find((r) => r.track_id === trackId)!;
  const nextNo = state.membership
    .filter((r) => r.album_id === albumId)
    .reduce((max, r) => Math.max(max, r.track_no ?? 0), 0);
  const before: Placement = { assigned: true, row: current };
  const after: Placement = {
    assigned: true,
    row: { ...current, album_id: albumId, track_no: nextNo + 1, disc_no: 1, title_override: null, artist_override: null },
  };
  return { kind: "assign", albumId, trackIds: [trackId], before: [before], after: [after] };
}

describe("applyCommand", () => {
  it("replaces an album's fields", () => {
    const next = { title: "Renamed", album_artist: "AA", year: 1999, genre: "Jazz" };
    const state = applyCommand(fixture(), { kind: "setAlbumFields", albumId: 1, next, prev: { title: "Album 1", album_artist: null, year: null, genre: null } });
    const a = state.albums.find((x) => x.id === 1)!;
    expect([a.title, a.album_artist, a.year, a.genre]).toEqual(["Renamed", "AA", 1999, "Jazz"]);
  });

  it("replaces one membership row's overrides and numbering", () => {
    const next = { title_override: "Clean", artist_override: null, track_no: 5, disc_no: 2 };
    const state = applyCommand(fixture(), {
      kind: "setTrackOverrides",
      albumId: 1,
      trackId: 11,
      next,
      prev: { title_override: null, artist_override: null, track_no: 2, disc_no: 1 },
    });
    const r = state.membership.find((x) => x.track_id === 11)!;
    expect([r.title_override, r.track_no, r.disc_no]).toEqual(["Clean", 5, 2]);
  });

  it("rewrites track_no to the new order", () => {
    const state = applyCommand(fixture(), { kind: "reorderTracks", albumId: 1, nextOrder: [11, 10], prevOrder: [10, 11] });
    const byId = new Map(state.membership.map((r) => [r.track_id, r.track_no]));
    expect(byId.get(11)).toBe(1);
    expect(byId.get(10)).toBe(2);
  });

  it("moves a track into another album and leaves it there only", () => {
    const state = applyCommand(fixture(), moveCommand(fixture(), 2, 11));
    expect(state.membership.filter((r) => r.track_id === 11).map((r) => r.album_id)).toEqual([2]);
    // Track 11 appends after B's existing track 20.
    expect(state.membership.find((r) => r.track_id === 11)!.track_no).toBe(2);
    expect(state.albums.find((a) => a.id === 1)!.track_count).toBe(1);
    expect(state.albums.find((a) => a.id === 2)!.track_count).toBe(2);
  });

  it("drops an unassigned track back to loose", () => {
    const cmd: Command = {
      kind: "unassign",
      albumId: 1,
      trackIds: [10],
      before: [{ assigned: true, row: row(1, 10, 1) }],
      after: [{ assigned: false, trackId: 10 }],
    };
    const state = applyCommand(fixture(), cmd);
    expect(state.membership.some((r) => r.track_id === 10)).toBe(false);
    expect(state.albums.find((a) => a.id === 1)!.track_count).toBe(1);
  });
});

describe("invertCommand", () => {
  const cases: Record<string, Command> = {
    setAlbumFields: {
      kind: "setAlbumFields",
      albumId: 1,
      next: { title: "Renamed", album_artist: "AA", year: 1999, genre: "Jazz" },
      prev: { title: "Album 1", album_artist: null, year: null, genre: null },
    },
    setTrackOverrides: {
      kind: "setTrackOverrides",
      albumId: 1,
      trackId: 11,
      next: { title_override: "Clean", artist_override: "X", track_no: 5, disc_no: 2 },
      prev: { title_override: null, artist_override: null, track_no: 2, disc_no: 1 },
    },
    reorderTracks: { kind: "reorderTracks", albumId: 1, nextOrder: [11, 10], prevOrder: [10, 11] },
    assign: moveCommand(fixture(), 2, 11),
    unassign: {
      kind: "unassign",
      albumId: 1,
      trackIds: [10],
      before: [{ assigned: true, row: row(1, 10, 1) }],
      after: [{ assigned: false, trackId: 10 }],
    },
  };

  for (const [name, cmd] of Object.entries(cases)) {
    it(`do then undo is identity for ${name}`, () => {
      const start = fixture();
      const undone = applyCommand(applyCommand(start, cmd), invertCommand(cmd));
      expect(undone).toEqual(start);
    });

    it(`double-invert round-trips for ${name}`, () => {
      expect(invertCommand(invertCommand(cmd))).toEqual(cmd);
    });
  }

  it("restores a moved track to its origin with the same row values", () => {
    const start = fixture();
    const cmd = moveCommand(start, 2, 11);
    const moved = applyCommand(start, cmd);
    const restored = applyCommand(moved, invertCommand(cmd));
    expect(restored.membership.find((r) => r.track_id === 11)).toEqual(row(1, 11, 2));
  });
});

describe("command sequences", () => {
  it("walks the state back through N undos and forward through redo", () => {
    const start = fixture();

    // Build each command against the state it actually applies to, the way the store captures prev.
    const before: OrgState[] = [];
    const sequence: Command[] = [];
    let state = start;

    const step = (cmd: Command): void => {
      before.push(state);
      sequence.push(cmd);
      state = applyCommand(state, cmd);
    };

    step({ kind: "reorderTracks", albumId: 1, nextOrder: [11, 10], prevOrder: [10, 11] });
    step({
      kind: "setAlbumFields",
      albumId: 2,
      next: { title: "B", album_artist: "BB", year: 2000, genre: null },
      prev: { title: "Album 2", album_artist: null, year: null, genre: null },
    });
    step(moveCommand(state, 2, 10));

    // Undo in reverse: each step returns to the state before that command.
    for (let i = sequence.length - 1; i >= 0; i--) {
      state = applyCommand(state, invertCommand(sequence[i]));
      expect(state).toEqual(before[i]);
    }
    expect(state).toEqual(start);

    // Redo the first command re-applies it.
    const redone = applyCommand(state, sequence[0]);
    expect(redone).toEqual(before[1]);
  });
});
