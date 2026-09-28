// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { applyCommand, commandToIpc, invertCommand } from "./orgCommands";
import { planAssign } from "./assignPlan";
import type { Command, OrgState } from "./orgCommands";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow } from "../../types";

// The write sink the engine calls, stubbed so a test can see which writes a command makes.
vi.mock("../../lib/ipc", () => ({
  addTracksToAlbum: vi.fn(async () => {}),
  reapplyAlbumsFromTags: vi.fn(async () => {}),
  removeTracksFromAlbum: vi.fn(async () => {}),
  revertAlbumsFromTags: vi.fn(async () => {}),
  setAlbumFields: vi.fn(async () => {}),
  setAlbumLayout: vi.fn(async () => {}),
  setMemberPlacement: vi.fn(async () => {}),
  setTrackOverrides: vi.fn(async () => {}),
}));

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

// The assign command the store builds for moving one track into an album.
function moveCommand(state: OrgState, albumId: number, trackId: number): Command {
  return planAssign(state.membership, [], albumId, [trackId])!;
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

// Swaps album A's two tracks on disc 1.
const swapLayout: Command = {
  kind: "setAlbumLayout",
  albumId: 1,
  next: [
    { track_id: 11, disc_no: 1, track_no: 1 },
    { track_id: 10, disc_no: 1, track_no: 2 },
  ],
  prev: [
    { track_id: 10, disc_no: 1, track_no: 1 },
    { track_id: 11, disc_no: 1, track_no: 2 },
  ],
};

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
    setAlbumLayout: swapLayout,
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

    step(swapLayout);
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

describe("commandToIpc", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes membership only for a move and for its undo, never the track's edits", async () => {
    const start = fixture();
    start.membership = start.membership.map((r) =>
      r.track_id === 11 ? { ...r, title_override: "Edited", artist_override: "Someone" } : r,
    );
    const cmd = moveCommand(start, 2, 11);

    await commandToIpc(cmd);
    expect(ipc.addTracksToAlbum).toHaveBeenCalledWith(2, [11]);
    expect(ipc.setMemberPlacement).toHaveBeenCalledWith(2, 11, 2, false);

    await commandToIpc(invertCommand(cmd));
    expect(ipc.addTracksToAlbum).toHaveBeenLastCalledWith(1, [11]);
    expect(ipc.setMemberPlacement).toHaveBeenLastCalledWith(1, 11, 2, false);

    expect(ipc.setTrackOverrides).not.toHaveBeenCalled();
  });

  it("writes membership only for an unassign, and its undo restores the keep-own-cover flag", async () => {
    const cmd: Command = {
      kind: "unassign",
      albumId: 1,
      trackIds: [10],
      before: [{ assigned: true, row: row(1, 10, 1, { title_override: "Edited", keep_own_cover: true }) }],
      after: [{ assigned: false, trackId: 10 }],
    };

    await commandToIpc(cmd);
    expect(ipc.removeTracksFromAlbum).toHaveBeenCalledWith(1, [10]);

    await commandToIpc(invertCommand(cmd));
    expect(ipc.addTracksToAlbum).toHaveBeenCalledWith(1, [10]);
    expect(ipc.setMemberPlacement).toHaveBeenCalledWith(1, 10, 1, true);

    expect(ipc.setTrackOverrides).not.toHaveBeenCalled();
  });
});
