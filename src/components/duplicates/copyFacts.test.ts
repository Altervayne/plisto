// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { countPlaylistsByTrack, describeCopy, differingFields, folderOf } from "./copyFacts";
import { middleEllipsis } from "../../lib/middleEllipsis";

// -- Type Imports --
import type { CopyContext } from "./copyFacts";
import type { AlbumRow, TrackRow } from "../../types";

function track(id: number, tags: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    source_path: `C:\\Music\\Band\\${id}.mp3`,
    filename: `${id}.mp3`,
    ext: "mp3",
    size_bytes: 2048,
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

function album(id: number, over: Partial<AlbumRow> = {}): AlbumRow {
  return {
    id,
    title: "Record",
    album_artist: null,
    year: null,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: 1,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const ctx = (over: Partial<CopyContext> = {}): CopyContext => ({
  albumIndex: new Map(),
  playlistsByTrack: new Map(),
  plays: null,
  identical: new Set(),
  labels: { single: "Single", unsorted: "Unsorted", untitled: "Untitled" },
  ...over,
});

describe("copyFacts", () => {
  it("names the folder without the filename on either separator", () => {
    expect(folderOf(track(1))).toBe("C:\\Music\\Band");
    expect(folderOf(track(1, { source_path: "/music/a/b.flac" }))).toBe("/music/a");
  });

  it("counts distinct playlists per track", () => {
    const slots = [
      { playlist_id: 1, track_id: 7 },
      { playlist_id: 1, track_id: 7 },
      { playlist_id: 2, track_id: 7 },
      { playlist_id: 2, track_id: 8 },
    ];
    expect(countPlaylistsByTrack(slots)).toEqual(new Map([[7, 2], [8, 1]]));
  });

  it("reads the placement from organization", () => {
    const albumIndex = new Map([
      [1, album(10)],
      [2, album(11, { kind: "single" })],
      [3, album(12, { title: null })],
    ]);
    const c = ctx({ albumIndex });
    expect(describeCopy(track(1), c).placement).toBe("Record");
    expect(describeCopy(track(2), c).placement).toBe("Single");
    expect(describeCopy(track(3), c).placement).toBe("Untitled");
    expect(describeCopy(track(4), c).placement).toBe("Unsorted");
  });

  it("keeps plays unknown until the counts land, then zero for no row", () => {
    expect(describeCopy(track(1), ctx()).plays).toBeNull();
    expect(describeCopy(track(1), ctx({ plays: new Map([[2, 5]]) })).plays).toBe(0);
    expect(describeCopy(track(2), ctx({ plays: new Map([[2, 5]]) })).plays).toBe(5);
  });

  it("flags only the facts that differ", () => {
    const a = describeCopy(track(1), ctx());
    const b = describeCopy(track(2, { ext: "flac", source_path: "C:\\Music\\Band\\2.flac" }), ctx());
    expect([...differingFields([a, b])].sort()).toEqual(["filename", "format"]);
  });

  it("cuts a long path in the middle", () => {
    expect(middleEllipsis("short", 10)).toBe("short");
    expect(middleEllipsis("/music/artist/album", 12)).toBe("/musi...lbum");
  });
});
