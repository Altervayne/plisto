// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- State Imports --
import { groupGone } from "../../state/gone/goneGroups";

// -- Unit Imports --
import { buildView, idsOf, summaryParts } from "./goneView";

// -- Type Imports --
import type { Root, TrackRow } from "../../types";

let nextId = 1;

function track(path: string, gone = true): TrackRow {
  return {
    id: nextId++,
    source_path: path,
    filename: path.split("/").pop() ?? path,
    missing_at: gone ? 5 : null,
  } as TrackRow;
}

function many(folder: string, count: number, gone = true): TrackRow[] {
  return Array.from({ length: count }, (_, i) => track(`${folder}/${i}.mp3`, gone));
}

function root(id: number, path: string, trackCount: number, missing = 0): Root {
  return { id, path, track_count: trackCount, missing_count: missing };
}

const view = (tracks: TrackRow[], roots: Root[], offline: number[] = []) =>
  buildView(groupGone(tracks, roots, offline, { kind: "all" }, []));

describe("buildView", () => {
  it("lists a few gone tracks flat and builds no blocks or folders", () => {
    const v = view(many("/m/a", 4), [root(1, "/m", 50, 4)]);
    expect(v.flat).toHaveLength(4);
    expect(v.total).toBe(4);
    expect([v.moved, v.likely, v.groups]).toEqual([[], [], []]);
  });

  it("leads with the likely-moved block when the total is small, then lists the rest flat", () => {
    const tracks = [...many("/m/ok", 3, false), ...many("/m/Rock", 15), track("/m/ok/a.mp3"), track("/m/ok/b.mp3")];
    const v = view(tracks, [root(1, "/m", 100, 17)]);
    expect(v.likely.map((g) => g.tracks.length)).toEqual([15]);
    expect(v.flat).toHaveLength(2);
    expect(v.groups).toEqual([]);
    expect(v.total).toBe(17);
    // The vanished folder, plus the one folder both scattered tracks sit in.
    expect(v.folders).toBe(2);
  });

  it("gives a small fully gone root its own block instead of a flat list", () => {
    const v = view(many("/old/a", 6), [root(1, "/old", 6, 6)]);
    expect(v.moved.map((m) => [m.root.id, m.tracks.length])).toEqual([[1, 6]]);
    expect(v.flat).toBeNull();
    expect(v.total).toBe(6);
  });

  it("groups the rest by folder when more than twenty sit outside the blocks", () => {
    const tracks = [
      ...many("/m/Rock", 15),
      track("/m/x/keep.mp3", false),
      ...many("/m/x", 12),
      track("/m/y/keep.mp3", false),
      ...many("/m/y", 12),
    ];
    const v = view(tracks, [root(1, "/m", 100, 39)]);
    expect(v.likely).toHaveLength(1);
    expect(v.flat).toBeNull();
    expect(v.groups).toHaveLength(2);
  });

  it("keeps offline roots that hold tracks and drops an empty one", () => {
    const roots = [root(1, "/m", 50), root(2, "/e/archive", 6240), root(3, "/e/empty", 0)];
    const v = view([...many("/m/a", 30, false), ...many("/m/b", 25)], roots, [2, 3]);
    expect(v.offline.map((o) => o.root.id)).toEqual([2]);
  });

  it("moves a fully gone root's tracks under its own block and out of the folder list", () => {
    const tracks = [...many("/old/a", 15), ...many("/old/b", 12), ...many("/m/keep", 3, false), ...many("/m/x", 25)];
    const v = view(tracks, [root(1, "/old", 27, 27), root(2, "/m", 100, 25)]);
    expect(v.moved.map((m) => [m.root.id, m.tracks.length])).toEqual([[1, 27]]);
    expect(v.groups.every((g) => g.rootId !== 1)).toBe(true);
    expect(v.total).toBe(52);
    // The header folder count is the blocks plus the folders under them: one moved root, the x folder.
    expect(v.folders).toBe(1 + v.likely.length + v.groups.length);
    const listed = v.moved.flatMap((m) => m.tracks).length + v.likely.concat(v.groups).flatMap((g) => g.tracks).length;
    expect(listed).toBe(v.total);
  });

  it("keeps a likely-moved folder as its own block, largest first", () => {
    const tracks = [...many("/m/ok", 2, false), ...many("/m/rock", 12), ...many("/m/jazz", 30)];
    const v = view(tracks, [root(1, "/m", 100, 42)]);
    expect(v.likely.map((g) => g.tracks.length)).toEqual([30, 12]);
  });
});

describe("summaryParts", () => {
  it("is a track count alone for a flat list with no block above it", () => {
    const v = view(many("/m/a", 4), [root(1, "/m", 50, 4)]);
    expect(summaryParts(v)).toEqual({ tracks: 4, folders: null });
  });

  it("adds the folder count when a block leads a flat list", () => {
    const tracks = [...many("/m/ok", 3, false), ...many("/m/Rock", 15), track("/m/ok/a.mp3"), track("/m/ok/b.mp3")];
    expect(summaryParts(view(tracks, [root(1, "/m", 100, 17)]))).toEqual({ tracks: 17, folders: 2 });
  });

  it("counts the folders of grouped tracks", () => {
    const tracks = [track("/m/x/keep.mp3", false), ...many("/m/x", 12), track("/m/y/keep.mp3", false), ...many("/m/y", 12)];
    expect(summaryParts(view(tracks, [root(1, "/m", 100, 24)]))).toEqual({ tracks: 24, folders: 2 });
  });
});

describe("idsOf", () => {
  it("returns the ids of exactly the tracks given, so a remove is scoped to its row", () => {
    const rock = many("/m/rock", 12);
    const jazz = many("/m/jazz", 11);
    const v = view([...many("/m/ok", 2, false), ...rock, ...jazz], [root(1, "/m", 100, 23)]);
    const group = v.likely.find((g) => g.path === "/m/rock");
    expect(idsOf(group?.tracks ?? []).sort((a, b) => a - b)).toEqual(idsOf(rock));
    expect(idsOf(group?.tracks ?? [])).not.toContain(jazz[0].id);
  });
});
