// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { albumsInPlaylists, pickedAlbumIds, playlistsHoldingAlbum } from "./albumPlaylists";
import { entryRow } from "../playlists/playlistTestRows";

describe("playlistsHoldingAlbum", () => {
  it("counts distinct playlists, an album twice in one playlist once", () => {
    const entries = [entryRow(1, 1, 7, true, 1), entryRow(2, 2, 7, false, 1), entryRow(3, 1, 7, true, 2)];
    expect(playlistsHoldingAlbum(entries, 7)).toBe(2);
  });

  it("is zero for an album no playlist holds", () => {
    expect(playlistsHoldingAlbum([entryRow(1, 1, 7, true)], 8)).toBe(0);
  });
});

describe("pickedAlbumIds", () => {
  it("follows the wall's order, not the order the albums were picked in", () => {
    const wall = [{ id: 4 }, { id: 2 }, { id: 9 }, { id: 7 }];
    expect(pickedAlbumIds(wall, new Set([9, 4, 7]))).toEqual([4, 9, 7]);
  });

  it("keeps a picked album the date filter hides, since the wall list is the whole wall", () => {
    expect(pickedAlbumIds([{ id: 1 }, { id: 2 }], new Set([2]))).toEqual([2]);
  });
});

describe("albumsInPlaylists", () => {
  it("counts the picked albums that sit in at least one playlist", () => {
    const entries = [entryRow(1, 1, 7, true), entryRow(2, 2, 7, true, 2), entryRow(3, 3, 9, true)];
    expect(albumsInPlaylists(entries, [7, 8, 9])).toBe(2);
    expect(albumsInPlaylists(entries, [8])).toBe(0);
  });
});
