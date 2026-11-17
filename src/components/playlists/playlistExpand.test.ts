// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { expandPlaylist, groupMembers } from "./playlistExpand";
import { entryRow, memberRow, slotRow } from "./playlistTestRows";
import fixture from "./playlistExpand.fixture.json";

// -- Type Imports --
import type { AlbumTrackRow, PlaylistAlbumEntryRow, PlaylistTrackRow } from "../../types";

const GONE = 1700000000;

/** The fixture's rows turned into the store's row shapes. */
function fixtureRows() {
  const looseGone = new Map(fixture.loose_tracks.map((t) => [t.track_id, t.missing]));
  const membership: AlbumTrackRow[] = fixture.albums.flatMap((album) =>
    album.members.map((m) =>
      memberRow(album.id, m.track_id, m.disc_no, m.track_no, m.missing ? GONE : null),
    ),
  );
  const slots: PlaylistTrackRow[] = [];
  const entries: PlaylistAlbumEntryRow[] = [];
  for (const row of fixture.playlist.slots) {
    if (row.album_id !== undefined) {
      entries.push(entryRow(row.id, row.position, row.album_id, row.keep_order === true));
    } else {
      const trackId = row.track_id ?? 0;
      slots.push(slotRow(row.id, row.position, trackId, looseGone.get(trackId) ? GONE : null));
    }
  }
  return { slots, entries, members: groupMembers(membership) };
}

describe("expandPlaylist against the golden fixture", () => {
  const { slots, entries, members } = fixtureRows();

  for (const expected of fixture.expected) {
    it(`reproduces the ${expected.present_only ? "present-only" : "all-tracks"} expansion`, () => {
      const out = expandPlaylist(slots, entries, members, {
        orgReady: true,
        presentOnly: expected.present_only,
      });
      expect(out.ids).toEqual(expected.ids);
      expect(out.blocks).toEqual(expected.blocks);
    });
  }

  it("counts track slots plus every member, missing included", () => {
    const out = expandPlaylist(slots, entries, members, { orgReady: true });
    expect(out.count).toBe(fixture.track_count);
  });

  it("sends the same expansion whatever order the rows arrive in", () => {
    const shuffled = expandPlaylist([...slots].reverse(), [...entries].reverse(), members, {
      orgReady: true,
    });
    expect(shuffled.ids).toEqual(fixture.expected[0].ids);
  });

  it("records each entry's first index", () => {
    const out = expandPlaylist(slots, entries, members, { orgReady: true });
    const firsts = out.entries.map((e) => [e.id, e.first]);
    expect(firsts).toEqual([[1, 0], [2, 1], [3, 7], [4, 8], [5, 9], [6, 11], [7, 17], [9, 19], [8, 22]]);
  });
});

describe("expandPlaylist keep order", () => {
  const members = groupMembers([memberRow(5, 50, 1, 1), memberRow(5, 51, 1, 2)]);

  it("gives an unflagged entry no block", () => {
    const out = expandPlaylist([], [entryRow(1, 1, 5, false)], members, { orgReady: true });
    expect(out.ids).toEqual([50, 51]);
    expect(out.blocks).toEqual([]);
  });

  it("gives a flagged entry one block over its members", () => {
    const out = expandPlaylist([slotRow(2, 1, 9)], [entryRow(1, 2, 5, true)], members, {
      orgReady: true,
    });
    expect(out.ids).toEqual([9, 50, 51]);
    expect(out.blocks).toEqual([[1, 2]]);
  });
});

describe("expandPlaylist member order bounds", () => {
  const order = (rows: ReturnType<typeof memberRow>[]) =>
    expandPlaylist([], [entryRow(1, 1, 5, false)], groupMembers(rows), { orgReady: true }).ids;

  it("clamps an oversized disc to the database bound", () => {
    expect(order([memberRow(5, 50, 200000, 1), memberRow(5, 51, 99999, 5)])).toEqual([50, 51]);
  });

  it("clamps a negative track number to zero", () => {
    expect(order([memberRow(5, 60, 1, -3), memberRow(5, 59, 1, 0)])).toEqual([59, 60]);
  });

  it("clamps a negative disc to zero, ahead of disc one", () => {
    expect(order([memberRow(5, 70, 1, 1), memberRow(5, 71, -4, 9)])).toEqual([71, 70]);
  });

  it("clamps an oversized track number to the database bound", () => {
    expect(order([memberRow(5, 80, 1, 2000000), memberRow(5, 81, 1, 999999)])).toEqual([80, 81]);
  });
});

describe("expandPlaylist readiness", () => {
  const members = groupMembers([memberRow(5, 50, 1, 1)]);
  const slots = [slotRow(2, 1, 9)];
  const entries = [entryRow(1, 2, 5, true)];

  it("is not ready with an album entry and no organize data, and yields no queue or count", () => {
    const out = expandPlaylist(slots, entries, members, { orgReady: false });
    expect(out.ready).toBe(false);
    expect(out.ids).toEqual([]);
    expect(out.blocks).toEqual([]);
    expect(out.count).toBeNull();
  });

  it("still lists the entries while loading, an album entry with no members", () => {
    const out = expandPlaylist(slots, entries, members, { orgReady: false });
    expect(out.entries.map((e) => e.kind)).toEqual(["track", "album"]);
    expect(out.entries[1].kind === "album" && out.entries[1].members).toEqual([]);
  });

  it("is ready with only track slots whatever the organize state", () => {
    const out = expandPlaylist(slots, [], members, { orgReady: false });
    expect(out.ready).toBe(true);
    expect(out.ids).toEqual([9]);
    expect(out.count).toBe(1);
  });

  it("is ready and empty for an empty playlist", () => {
    const out = expandPlaylist([], [], members, { orgReady: false });
    expect(out.ready).toBe(true);
    expect(out.count).toBe(0);
  });
});
