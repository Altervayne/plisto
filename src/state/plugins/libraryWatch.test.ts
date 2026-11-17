// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { MAX_CHANGE_IDS, diffLibrary, diffOrg, mergeChanges, sameSnapshot } from "./libraryWatch";

// -- Type Imports --
import type { LibrarySnapshot } from "./libraryWatch";
import type {
  AlbumRow,
  AlbumTrackRow,
  PlaylistAlbumEntryRow,
  PlaylistRow,
  PlaylistTrackRow,
  TrackRow,
} from "../../types";

const track = (id: number): TrackRow => ({ id }) as TrackRow;
const album = (id: number): AlbumRow => ({ id, track_count: 1 }) as AlbumRow;
const member = (albumId: number, trackId: number): AlbumTrackRow =>
  ({ album_id: albumId, track_id: trackId }) as AlbumTrackRow;
const playlist = (id: number): PlaylistRow => ({ id }) as PlaylistRow;
const slot = (id: number): PlaylistTrackRow => ({ id }) as PlaylistTrackRow;

function snap(over: Partial<LibrarySnapshot> = {}): LibrarySnapshot {
  return {
    tracks: [],
    albums: [],
    membership: [],
    playlists: [],
    slots: [],
    albumEntries: [],
    ...over,
  };
}

describe("diffLibrary", () => {
  const tracks = [track(1), track(2), track(3)];

  it("reports nothing when no row changed", () => {
    expect(diffLibrary(snap({ tracks }), snap({ tracks: [...tracks] }))).toBeNull();
  });

  it("gives the id of the one edited row", () => {
    const next = [tracks[0], { ...tracks[1] }, tracks[2]];
    expect(diffLibrary(snap({ tracks }), snap({ tracks: next }))).toEqual({
      track_ids: [2],
      albums: false,
      playlists: false,
    });
  });

  it("gives an added and a removed row", () => {
    const next = [tracks[0], tracks[1], track(4)];
    expect(diffLibrary(snap({ tracks }), snap({ tracks: next }))?.track_ids).toEqual([3, 4]);
  });

  it("gives null for a reload that replaced every row", () => {
    const next = tracks.map((t) => ({ ...t }));
    expect(diffLibrary(snap({ tracks }), snap({ tracks: next }))).toEqual({
      track_ids: null,
      albums: false,
      playlists: false,
    });
  });

  it("gives null past the id cap", () => {
    const rows = Array.from({ length: MAX_CHANGE_IDS + 2 }, (_, i) => track(i));
    const next = [...rows.slice(0, -1).map((t) => ({ ...t })), rows[rows.length - 1]];
    expect(diffLibrary(snap({ tracks: rows }), snap({ tracks: next }))?.track_ids).toBeNull();
  });

  it("sets albums and lists the member ids for a membership change", () => {
    const a = member(7, 1);
    const b = member(7, 2);
    const next = snap({ tracks, membership: [a, { ...b }] });
    expect(diffLibrary(snap({ tracks, membership: [a, b] }), next)).toEqual({
      track_ids: [2],
      albums: true,
      playlists: false,
    });
  });

  it("lists the members of a changed album, whose fields resolve into them", () => {
    const a = album(7);
    const members = [member(7, 1), member(7, 2), member(8, 3)];
    const next = snap({ tracks, albums: [{ ...a }], membership: members });
    expect(diffLibrary(snap({ tracks, albums: [a], membership: members }), next)).toEqual({
      track_ids: [1, 2],
      albums: true,
      playlists: false,
    });
  });

  it("flags playlists for a changed playlist or slot", () => {
    const p = playlist(1);
    const s = slot(1);
    const base = snap({ tracks, playlists: [p], slots: [s] });
    expect(diffLibrary(base, snap({ tracks, playlists: [{ ...p }], slots: [s] }))).toEqual({
      track_ids: [],
      albums: false,
      playlists: true,
    });
    expect(diffLibrary(base, snap({ tracks, playlists: [p], slots: [] }))?.playlists).toBe(true);
  });
});

describe("diffLibrary with album entries", () => {
  const tracks = [track(1), track(2), track(3)];
  const entry = (id: number, albumId: number): PlaylistAlbumEntryRow =>
    ({ id, album_id: albumId }) as PlaylistAlbumEntryRow;
  const members = [member(7, 1), member(7, 2), member(8, 3)];

  it("flags playlists for an added, removed or replaced entry", () => {
    const e = entry(1, 7);
    const base = snap({ tracks, membership: members, albumEntries: [e] });
    expect(diffLibrary(base, snap({ tracks, membership: members, albumEntries: [] }))?.playlists).toBe(true);
    expect(diffLibrary(snap({ tracks, membership: members }), base)?.playlists).toBe(true);
    expect(diffLibrary(base, { ...base, albumEntries: [{ ...e }] })?.playlists).toBe(true);
  });

  it("flags playlists when an album an entry references changes", () => {
    const a = album(7);
    const referenced = [entry(1, 7)];
    const base = snap({ tracks, albums: [a], membership: members, albumEntries: referenced });
    const next = snap({ tracks, albums: [{ ...a }], membership: members, albumEntries: referenced });
    expect(diffLibrary(base, next)).toEqual({ track_ids: [1, 2], albums: true, playlists: true });
  });

  it("leaves playlists alone when the changed album is not referenced", () => {
    const a = album(8);
    const referenced = [entry(1, 7)];
    const base = snap({ tracks, albums: [a], membership: members, albumEntries: referenced });
    const next = snap({ tracks, albums: [{ ...a }], membership: members, albumEntries: referenced });
    expect(diffLibrary(base, next)?.playlists).toBe(false);
  });

  it("flags playlists when a referenced album gains or loses a member", () => {
    const referenced = [entry(1, 7)];
    const base = snap({ tracks, membership: members, albumEntries: referenced });
    const gained = [...members, member(7, 3)];
    expect(diffLibrary(base, { ...base, membership: gained })?.playlists).toBe(true);
    const left = [members[0], { ...members[1], album_id: 9 }, members[2]];
    expect(diffLibrary(base, { ...base, membership: left })?.playlists).toBe(true);
    const elsewhere = [members[0], members[1]];
    expect(diffLibrary(base, { ...base, membership: elsewhere })?.playlists).toBe(false);
  });

  it("flags playlists when a member track of a referenced album changes", () => {
    const referenced = [entry(1, 7)];
    const base = snap({ tracks, membership: members, albumEntries: referenced });
    const edited = [tracks[0], { ...tracks[1] }, tracks[2]];
    expect(diffLibrary(base, { ...base, tracks: edited })?.playlists).toBe(true);
    const other = [tracks[0], tracks[1], { ...tracks[2] }];
    expect(diffLibrary(base, { ...base, tracks: other })?.playlists).toBe(false);
  });

  it("flags a referenced album through the org diff, which carries the entries", () => {
    const a = album(7);
    const before = { albums: [a], membership: members };
    const after = { albums: [{ ...a }], membership: members };
    expect(diffOrg(before, after)?.playlists).toBe(false);
    expect(diffOrg(before, after, [entry(1, 7)])?.playlists).toBe(true);
  });
});

describe("mergeChanges", () => {
  it("unions ids and ORs the flags", () => {
    const merged = mergeChanges(
      { track_ids: [3, 1], albums: false, playlists: true },
      { track_ids: [2, 1], albums: true, playlists: false },
    );
    expect(merged).toEqual({ track_ids: [1, 2, 3], albums: true, playlists: true });
  });

  it("lets null absorb the ids", () => {
    const none = { albums: false, playlists: false };
    expect(mergeChanges({ track_ids: null, ...none }, { track_ids: [1], ...none }).track_ids).toBeNull();
  });
});

describe("diffLibrary reloads and no-ops", () => {
  it("gives null for a reload that also removed rows", () => {
    // Two rows replaced and one gone: the changed count equals the new length, so only >= reads a reload.
    const kept = track(3);
    const prev = [track(1), track(2), kept, track(4)];
    const next = [track(1), track(2), kept];
    expect(diffLibrary(snap({ tracks: prev }), snap({ tracks: next }))?.track_ids).toBeNull();
  });

  it("sees an untouched snapshot as the same", () => {
    const a = snap({ tracks: [track(1)] });
    expect(sameSnapshot(a, { ...a })).toBe(true);
    expect(sameSnapshot(a, { ...a, slots: [slot(1)] })).toBe(false);
  });
});
