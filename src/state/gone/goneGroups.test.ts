// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { FLAT_MAX, GROUP_PAGE, groupGone, pageGroups } from "./goneGroups";

// -- Type Imports --
import type { AlbumTrackRow, Root, TrackRow } from "../../types";
import type { GoneScope } from "./goneGroups";

let nextId = 1;

function track(path: string, gone = false): TrackRow {
  const id = nextId++;
  return {
    id,
    source_path: path,
    filename: path.split(/[\\/]/).pop() ?? path,
    ext: "mp3",
    size_bytes: 1,
    mtime: 1,
    duration_secs: 100,
    raw_title: null,
    raw_artist: null,
    raw_album: null,
    raw_album_artist: null,
    raw_track_no: null,
    raw_disc_no: null,
    raw_year: null,
    raw_genre: null,
    scanned_at: 1,
    missing_at: gone ? 5 : null,
    display_path: path,
    title_edit: null,
    artist_edit: null,
    album_edit: null,
    album_artist_edit: null,
    year_edit: null,
    disc_edit: null,
    genre_ids: [],
  };
}

/** `count` tracks in one folder. */
function many(folder: string, count: number, gone: boolean): TrackRow[] {
  return Array.from({ length: count }, (_, i) => track(`${folder}/${i}.mp3`, gone));
}

function root(id: number, path: string, trackCount = 100, missing = 0): Root {
  return { id, path, track_count: trackCount, missing_count: missing };
}

function member(albumId: number, trackId: number): AlbumTrackRow {
  return { album_id: albumId, track_id: trackId } as AlbumTrackRow;
}

const ALL: GoneScope = { kind: "all" };
const run = (tracks: TrackRow[], roots: Root[], offline: number[] = [], scope: GoneScope = ALL, members: AlbumTrackRow[] = []) =>
  groupGone(tracks, roots, offline, scope, members);

describe("groupGone", () => {
  it("finds a folder with no present track as likely moved, and keeps present folders as plain groups", () => {
    const tracks = [
      ...many("D:/Music/Rock", 12, true),
      ...many("D:/Music/Jazz", 15, false),
      ...many("D:/Music/Jazz/Live", 3, true),
    ];
    const r = run(tracks, [root(1, "D:/Music")]);
    expect(r.likely.map((g) => [g.path, g.tracks.length])).toEqual([["D:/Music/Rock", 12]]);
    expect(r.groups.map((g) => [g.path, g.tracks.length])).toEqual([["D:/Music/Jazz/Live", 3]]);
    expect(r.total).toBe(15);
    expect(r.folderCount).toBe(2);
  });

  it("reads the topmost vanished folder, so a deep subtree is one likely group", () => {
    const tracks = [...many("D:/Music/Rock/A", 6, true), ...many("D:/Music/Rock/B", 6, true), track("D:/Music/x.mp3")];
    const r = run(tracks, [root(1, "D:/Music")]);
    expect(r.likely).toHaveLength(1);
    expect(r.likely[0].path).toBe("D:/Music/Rock");
    expect(r.likely[0].tracks).toHaveLength(12);
    expect(r.groups).toHaveLength(0);
  });

  it("does not call a folder likely moved below the minimum or when a present track sits under it", () => {
    const few = run([...many("D:/Music/Rock", 9, true), track("D:/Music/x.mp3")], [root(1, "D:/Music")]);
    expect(few.likely).toHaveLength(0);
    expect(few.groups[0].tracks).toHaveLength(9);
    const kept = run(
      [...many("D:/Music/Rock", 12, true), track("D:/Music/Rock/Deep/ok.mp3")],
      [root(1, "D:/Music")],
    );
    expect(kept.likely).toHaveLength(0);
  });

  it("matches folders across separators and case", () => {
    const tracks = [...many("D:\\Music\\Rock", 10, true), track("d:/music/other/a.mp3")];
    const r = run(tracks, [root(1, "D:\\Music")]);
    expect(r.likely).toHaveLength(1);
    expect(r.likely[0].path).toBe("D:\\Music\\Rock");
  });

  it("keeps a folder above a live nested root from reading as moved", () => {
    const tracks = [...many("/m/X/old", 10, true), track("/m/X/in/ok.mp3"), track("/m/top.mp3")];
    const r = run(tracks, [root(1, "/m"), root(2, "/m/X/in")]);
    expect(r.likely.map((g) => g.path)).toEqual(["/m/X/old"]);
    expect(r.groups).toHaveLength(0);
  });

  it("lists an offline root with nothing gone, its track count left for the caller to filter", () => {
    const r = run([track("/m/a.mp3")], [root(1, "/m"), root(2, "E:/Empty", 0, 0)], [2]);
    expect(r.offlineRoots).toEqual([{ root: root(2, "E:/Empty", 0, 0), goneCount: 0 }]);
  });

  it("lists the gone tracks flat up to the limit and groups beyond it", () => {
    const base = [track("D:/Music/keep.mp3")];
    const atLimit = run([...base, ...many("D:/Music/A", FLAT_MAX, true)], [root(1, "D:/Music")]);
    expect(atLimit.flat).toHaveLength(FLAT_MAX);
    const over = run([...base, ...many("D:/Music/A", FLAT_MAX + 1, true)], [root(1, "D:/Music")]);
    expect(over.flat).toBeNull();
    expect(over.total).toBe(FLAT_MAX + 1);
  });

  it("has no flat list and no total when nothing is gone", () => {
    const r = run([track("D:/Music/a.mp3")], [root(1, "D:/Music")]);
    expect(r.flat).toBeNull();
    expect(r.total).toBe(0);
    expect(r.ids).toEqual([]);
  });

  it("excludes offline roots and reports them separately", () => {
    const tracks = [
      ...many("E:/Archive/Old", 30, true),
      ...many("E:/Archive/Kept", 5, false),
      ...many("D:/Music/A", 3, true),
      track("D:/Music/ok.mp3"),
    ];
    const roots = [root(1, "D:/Music"), root(2, "E:/Archive", 35, 30)];
    const r = run(tracks, roots, [2]);
    expect(r.total).toBe(3);
    expect(r.likely).toHaveLength(0);
    expect(r.offlineRoots.map((o) => [o.root.id, o.goneCount])).toEqual([[2, 30]]);
    expect(r.ids).toHaveLength(3);
  });

  it("scopes to one root, and reports only that offline root", () => {
    const tracks = [...many("D:/Music/A", 4, true), ...many("F:/Other/B", 6, true), track("D:/Music/ok.mp3"), track("F:/Other/ok.mp3")];
    const roots = [root(1, "D:/Music"), root(2, "F:/Other"), root(3, "E:/Archive")];
    const r = run(tracks, roots, [3], { kind: "root", rootId: 2 });
    expect(r.total).toBe(6);
    expect(r.offlineRoots).toEqual([]);
    const off = run(tracks, roots, [3], { kind: "root", rootId: 3 });
    expect(off.offlineRoots.map((o) => o.root.id)).toEqual([3]);
    expect(off.total).toBe(0);
  });

  it("scopes to one album's members", () => {
    const a = track("D:/Music/A/1.mp3", true);
    const b = track("D:/Music/A/2.mp3", true);
    const c = track("D:/Music/B/3.mp3", true);
    const ok = track("D:/Music/A/4.mp3");
    const r = run([a, b, c, ok], [root(1, "D:/Music")], [], { kind: "album", albumId: 7 }, [
      member(7, a.id),
      member(7, ok.id),
      member(8, c.id),
    ]);
    expect(r.ids).toEqual([a.id]);
    expect(r.flat?.map((t) => t.id)).toEqual([a.id]);
  });

  it("judges a vanished folder against every present track, not only those in scope", () => {
    const gone = many("D:/Music/Rock", 12, true);
    const present = track("D:/Music/Rock/ok.mp3");
    const r = run([...gone, present], [root(1, "D:/Music")], [], { kind: "album", albumId: 1 }, gone.map((g) => member(1, g.id)));
    expect(r.likely).toHaveLength(0);
    expect(r.groups).toHaveLength(1);
  });

  it("reports a fully gone online root and never calls its folders likely moved", () => {
    const tracks = many("D:/Music/Rock", 12, true);
    const r = run(tracks, [root(1, "D:/Music", 12, 12)]);
    expect(r.fullyGoneRoots.map((x) => x.id)).toEqual([1]);
    expect(r.likely).toHaveLength(0);
    expect(r.groups).toHaveLength(1);
  });

  it("orders groups by size, then path", () => {
    const tracks = [
      track("D:/Music/ok.mp3"),
      ...many("D:/Music/B", 3, true),
      ...many("D:/Music/A", 3, true),
      ...many("D:/Music/C", 9, true),
      track("D:/Music/B/ok.mp3"),
      track("D:/Music/A/ok.mp3"),
      track("D:/Music/C/ok.mp3"),
    ];
    const r = run(tracks, [root(1, "D:/Music")]);
    expect(r.groups.map((g) => g.id)).toEqual(["d:/music/c", "d:/music/a", "d:/music/b"]);
  });

  it("sums the totals across likely moved and groups", () => {
    const tracks = [
      ...many("D:/Music/Rock", 14, true),
      ...many("D:/Music/Jazz", 7, true),
      ...many("D:/Music/Live", 4, true),
      track("D:/Music/Jazz/ok.mp3"),
      track("D:/Music/Live/ok.mp3"),
    ];
    const r = run(tracks, [root(1, "D:/Music")]);
    const listed = r.likely.reduce((n, g) => n + g.tracks.length, 0) + r.groups.reduce((n, g) => n + g.tracks.length, 0);
    expect(listed).toBe(r.total);
    expect(r.total).toBe(25);
    expect(r.folderCount).toBe(3);
  });
});

describe("pageGroups", () => {
  it("shows a page and counts the folders and tracks behind it", () => {
    const tracks = [track("D:/Music/ok.mp3")];
    for (let i = 0; i < 8; i++) {
      tracks.push(track(`D:/Music/F${i}/ok.mp3`), ...many(`D:/Music/F${i}`, 8 - i, true));
    }
    const r = run(tracks, [root(1, "D:/Music")]);
    const page = pageGroups(r.groups, GROUP_PAGE);
    expect(page.visible).toHaveLength(GROUP_PAGE);
    expect(page.hiddenFolders).toBe(3);
    expect(page.hiddenTracks).toBe(3 + 2 + 1);
    expect(pageGroups(r.groups, GROUP_PAGE * 2)).toMatchObject({ hiddenFolders: 0, hiddenTracks: 0 });
  });
});
