// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { groupByAlbumTags, inPlayOrder } from "./groupByAlbumTags";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

// A loose scanned row at `path`, the tags a case does not set defaulted to null.
function track(id: number, path: string, tags: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    source_path: path,
    filename: path.slice(path.lastIndexOf("/") + 1),
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
    display_path: path,
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
    title: null,
    album_artist: null,
    year: null,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: 0,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function member(albumId: number, trackId: number, trackNo: number, discNo: number | null = 1): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: `/m/x/${trackId}.mp3`,
    filename: `${trackId}.mp3`,
    duration_secs: 100,
    track_no: trackNo,
    disc_no: discNo,
    raw_title: null,
    raw_artist: null,
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at: null,
    keep_own_cover: false,
    genre_ids: [],
  };
}

// Two tracks of one clean album in one folder, numbered 1 and 2.
function pair(firstId: number, tags: Partial<TrackRow>, folder = "/m/a"): TrackRow[] {
  return [
    track(firstId, `${folder}/1.mp3`, { raw_track_no: 1, ...tags }),
    track(firstId + 1, `${folder}/2.mp3`, { raw_track_no: 2, ...tags }),
  ];
}

describe("groupByAlbumTags", () => {
  it("groups on the folded album and album artist", () => {
    const tracks = [
      track(1, "/m/a/1.mp3", { raw_album: "Blue", raw_album_artist: "Joni", raw_track_no: 1 }),
      track(2, "/m/a/2.mp3", { raw_album: " blue ", raw_album_artist: "JONI", raw_track_no: 2 }),
    ];
    const preview = groupByAlbumTags(tracks, [], []);
    expect(preview.proposals).toHaveLength(1);
    expect(preview.proposals[0].tracks.map((t) => t.id)).toEqual([1, 2]);
    expect(preview.trackCount).toBe(2);
  });

  it("keeps a null album artist apart from a tagged one of the same title", () => {
    const tracks = [
      ...pair(1, { raw_album: "Greatest Hits", raw_album_artist: "Queen", raw_artist: "Queen" }),
      ...pair(3, { raw_album: "Greatest Hits", raw_artist: "Queen" }, "/m/b"),
    ];
    expect(groupByAlbumTags(tracks, [], []).proposals).toHaveLength(2);
  });

  it("reads the edit layer over the raw tags", () => {
    const tracks = [
      track(1, "/m/a/1.mp3", { raw_album: "Wrong", album_edit: "Right", raw_track_no: 1 }),
      track(2, "/m/a/2.mp3", { raw_album: "Right", raw_track_no: 2 }),
    ];
    const [proposal] = groupByAlbumTags(tracks, [], []).proposals;
    expect(proposal.title).toBe("Right");
    expect(proposal.tracks).toHaveLength(2);
  });

  it("leaves untagged and lone tracks loose", () => {
    const tracks = [
      track(1, "/m/a/1.mp3"),
      track(2, "/m/a/2.mp3", { raw_album: "   " }),
      track(3, "/m/a/3.mp3", { raw_album: "Alone" }),
    ];
    const preview = groupByAlbumTags(tracks, [], []);
    expect(preview.proposals).toHaveLength(0);
    expect(preview.looseCount).toBe(3);
  });

  it("proposes a lone track that matches an existing album", () => {
    const tracks = [track(1, "/m/a/1.mp3", { raw_album: "Blue", raw_track_no: 9 })];
    const albums = [album(7, { title: "blue" })];
    const [proposal] = groupByAlbumTags(tracks, albums, []).proposals;
    expect(proposal.matches.map((m) => m.album.id)).toEqual([7]);
  });

  it("skips a group whose files are all missing and notes missing files otherwise", () => {
    const tracks = [
      ...pair(1, { raw_album: "Gone", missing_at: 5 }),
      track(3, "/m/b/1.mp3", { raw_album: "Half", raw_track_no: 1, missing_at: 5 }),
      track(4, "/m/b/2.mp3", { raw_album: "Half", raw_track_no: 2 }),
    ];
    const preview = groupByAlbumTags(tracks, [], []);
    expect(preview.skippedMissing).toBe(1);
    expect(preview.proposals).toHaveLength(1);
    expect(preview.proposals[0].tracks).toHaveLength(2);
    expect(preview.proposals[0].notes).toContainEqual({ kind: "missing", count: 1 });
  });

  it("orders by disc, track number, path, then id", () => {
    const tags = { raw_album: "Set" };
    const tracks = [
      track(1, "/m/a/z.mp3", { ...tags, raw_disc_no: 2, raw_track_no: 1 }),
      track(2, "/m/a/b.mp3", { ...tags }),
      track(3, "/m/a/y.mp3", { ...tags, raw_track_no: 2 }),
      track(4, "/m/a/a.mp3", { ...tags }),
      track(5, "/m/a/x.mp3", { ...tags, raw_track_no: 1, disc_edit: 1, raw_disc_no: 2 }),
    ];
    const [proposal] = groupByAlbumTags(tracks, [], []).proposals;
    expect(proposal.tracks.map((t) => t.id)).toEqual([5, 3, 4, 2, 1]);
    expect(proposal.discCount).toBe(2);
  });

  it("seeds the most common spelling and year, trimmed", () => {
    const tracks = [
      track(1, "/m/a/1.mp3", { raw_album: "Blue ", raw_album_artist: "Joni", raw_year: 1971, raw_track_no: 1 }),
      track(2, "/m/a/2.mp3", { raw_album: "blue", raw_album_artist: "Joni", raw_year: 1971, raw_track_no: 2 }),
      track(3, "/m/a/3.mp3", { raw_album: "Blue ", raw_album_artist: "Joni", raw_year: 1972, raw_track_no: 3, raw_genre: "Folk" }),
    ];
    const [proposal] = groupByAlbumTags(tracks, [], []).proposals;
    expect(proposal.fields).toEqual({ title: "Blue", album_artist: "Joni", year: 1971, genre: "Folk" });
    expect(proposal.notes).toContainEqual({ kind: "years", year: 1971 });
  });

  it("borrows a shared track artist when no album artist is tagged", () => {
    const tracks = pair(1, { raw_album: "Blue", raw_artist: "Joni" });
    const [proposal] = groupByAlbumTags(tracks, [], []).proposals;
    expect(proposal.fields.album_artist).toBe("Joni");
    expect(proposal.notes.some((n) => n.kind === "compilation")).toBe(false);
  });

  it("leaves a compilation without an album artist and notes it", () => {
    const tracks = [
      track(1, "/m/a/1.mp3", { raw_album: "Hits", raw_artist: "One", raw_track_no: 1 }),
      track(2, "/m/a/2.mp3", { raw_album: "Hits", raw_artist: "Two", raw_track_no: 2 }),
    ];
    const [proposal] = groupByAlbumTags(tracks, [], []).proposals;
    expect(proposal.fields.album_artist).toBeNull();
    expect(proposal.notes).toContainEqual({ kind: "compilation" });
  });

  it("notes differing genres, unnumbered tracks and a numbering gap", () => {
    const tracks = [
      track(1, "/m/a/1.mp3", { raw_album: "A", raw_track_no: 1, raw_genre: "Rock" }),
      track(2, "/m/a/3.mp3", { raw_album: "A", raw_track_no: 3, raw_genre: "Jazz" }),
      track(3, "/m/a/x.mp3", { raw_album: "A" }),
    ];
    const kinds = groupByAlbumTags(tracks, [], []).proposals[0].notes.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["genres", "unnumbered", "gap"]));
  });

  it("flags duplicate numbers on a disc", () => {
    const tracks = [
      track(1, "/m/a/1.mp3", { raw_album: "A", raw_track_no: 1 }),
      track(2, "/m/a/2.mp3", { raw_album: "A", raw_track_no: 1 }),
    ];
    const [proposal] = groupByAlbumTags(tracks, [], []).proposals;
    expect(proposal.warnings).toContainEqual({ kind: "duplicates" });
  });

  it("accepts disc folders under one parent and flags other spreads", () => {
    const discs = [
      track(1, "/m/set/cd1/1.mp3", { raw_album: "Set", raw_disc_no: 1, raw_track_no: 1 }),
      track(2, "/m/set/cd2/1.mp3", { raw_album: "Set", raw_disc_no: 2, raw_track_no: 1 }),
    ];
    expect(groupByAlbumTags(discs, [], []).proposals[0].warnings).toEqual([]);

    const sameDisc = [
      track(1, "/m/one/1.mp3", { raw_album: "Set", raw_track_no: 1 }),
      track(2, "/m/two/2.mp3", { raw_album: "Set", raw_track_no: 2 }),
    ];
    expect(groupByAlbumTags(sameDisc, [], []).proposals[0].warnings).toContainEqual({ kind: "folders" });

    const apart = [
      track(1, "/m/a/cd1/1.mp3", { raw_album: "Set", raw_disc_no: 1, raw_track_no: 1 }),
      track(2, "/m/b/cd2/1.mp3", { raw_album: "Set", raw_disc_no: 2, raw_track_no: 1 }),
    ];
    expect(groupByAlbumTags(apart, [], []).proposals[0].warnings).toContainEqual({ kind: "folders" });
  });

  it("matches plain albums only, a compilation matching a null album artist", () => {
    const tracks = [
      track(1, "/m/a/1.mp3", { raw_album: "Blue", raw_artist: "One", raw_track_no: 1 }),
      track(2, "/m/a/2.mp3", { raw_album: "Blue", raw_artist: "Two", raw_track_no: 2 }),
    ];
    const albums = [
      album(1, { title: "Blue" }),
      album(2, { title: "Blue", album_artist: "One" }),
      album(3, { title: "Blue", kind: "single" }),
    ];
    const [proposal] = groupByAlbumTags(tracks, albums, []).proposals;
    expect(proposal.matches.map((m) => m.album.id)).toEqual([1]);
  });

  it("matches on the borrowed track artist when no album artist is tagged", () => {
    const tracks = [track(1, "/m/a/9.mp3", { raw_album: "Blue", raw_artist: "Joni", raw_track_no: 9 })];
    const albums = [album(1, { title: "Blue" }), album(2, { title: "Blue", album_artist: " joni " })];
    const [proposal] = groupByAlbumTags(tracks, albums, []).proposals;
    expect(proposal.matches.map((m) => m.album.id)).toEqual([2]);
  });

  it("flags an incoming number inside the target disc's range", () => {
    const tracks = [
      track(1, "/m/a/2.mp3", { raw_album: "Blue", raw_track_no: 2 }),
      track(2, "/m/a/9.mp3", { raw_album: "Blue", raw_disc_no: 2, raw_track_no: 9 }),
    ];
    const clash = [member(5, 10, 1), member(5, 11, 3)];
    const clear = [member(6, 12, 1), member(6, 13, 3, 2)];
    const albums = [album(5, { title: "Blue" }), album(6, { title: "Blue" })];
    const [proposal] = groupByAlbumTags(tracks, albums, [...clash, ...clear]).proposals;
    expect(proposal.matches.map((m) => [m.album.id, m.collides])).toEqual([
      [5, true],
      [6, false],
    ]);
  });

  it("sorts by album artist then title, a missing artist last", () => {
    const tracks = [
      ...pair(1, { raw_album: "Zed", raw_album_artist: "Abba" }),
      ...pair(3, { raw_album: "Alpha", raw_album_artist: "Beck" }, "/m/b"),
      ...pair(5, { raw_album: "Mix", raw_artist: "X" }, "/m/c"),
      ...pair(7, { raw_album: "Comp", raw_album_artist: null }, "/m/d"),
      ...pair(9, { raw_album: "Able", raw_album_artist: "Abba" }, "/m/e"),
    ];
    const titles = groupByAlbumTags(tracks, [], []).proposals.map((p) => p.title);
    expect(titles).toEqual(["Able", "Zed", "Alpha", "Mix", "Comp"]);
  });
});

describe("inPlayOrder", () => {
  it("sorts a selection by disc, then track number with unnumbered last, then path", () => {
    const tracks = [
      track(1, "/m/a/z.mp3", { raw_disc_no: 2, raw_track_no: 1 }),
      track(2, "/m/a/y.mp3", { raw_track_no: 2 }),
      track(3, "/m/a/x.mp3", { raw_disc_no: 1, raw_track_no: 1 }),
      track(4, "/m/a/b.mp3"),
      track(5, "/m/a/a.mp3"),
      track(6, "/m/a/w.mp3", { raw_disc_no: 3, raw_track_no: 1, disc_edit: 1 }),
    ];
    expect(inPlayOrder([1, 2, 3, 4, 5, 6], tracks)).toEqual([6, 3, 2, 5, 4, 1]);
  });

  it("keeps ids with no track row after the known ones, in their given order", () => {
    const tracks = [track(1, "/m/a/2.mp3", { raw_track_no: 2 }), track(2, "/m/a/1.mp3", { raw_track_no: 1 })];
    expect(inPlayOrder([9, 1, 8, 2], tracks)).toEqual([2, 1, 9, 8]);
  });
});
