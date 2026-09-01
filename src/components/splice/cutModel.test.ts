// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  deriveSegments,
  pruneMeta,
  replaceByOrigin,
  START_ID,
  toJobSegments,
  type Marker,
  type SegmentMeta,
} from "./cutModel";

/** A fresh monotonic id generator, mirroring the hook's counter. */
function idGen(): () => string {
  let n = 0;
  return () => `g${(n += 1)}`;
}

/** A marker literal. */
function marker(id: string, frame: number, origin: Marker["origin"] = "manual"): Marker {
  return { id, frame, origin };
}

describe("deriveSegments", () => {
  it("turns N markers into N+1 segments over the fixed timeline", () => {
    const markers = [marker("a", 100), marker("b", 200)];
    const segs = deriveSegments(markers, 300, new Map());
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [0, 100],
      [100, 200],
      [200, 300],
    ]);
    expect(segs.map((s) => s.id)).toEqual([START_ID, "a", "b"]);
  });

  it("leads the first segment with START and reads metadata by leading id", () => {
    const meta = new Map<string, SegmentMeta>([
      [START_ID, { title: "Intro" }],
      ["a", { title: "Middle" }],
    ]);
    const segs = deriveSegments([marker("a", 100)], 200, meta);
    expect(segs[0].meta.title).toBe("Intro");
    expect(segs[1].meta.title).toBe("Middle");
  });

  it("sorts and drops duplicate-frame markers before carving", () => {
    const markers = [marker("b", 200), marker("a", 100), marker("c", 100)];
    const segs = deriveSegments(markers, 300, new Map());
    // The second marker at frame 100 is dropped: three markers, but two survive, so three segments.
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.id)).toEqual([START_ID, "a", "b"]);
  });

  it("carries the leading marker origin, absent for the first segment", () => {
    const segs = deriveSegments([marker("a", 100, "silence")], 200, new Map());
    expect(segs[0].leadingOrigin).toBeUndefined();
    expect(segs[1].leadingOrigin).toBe("silence");
  });
});

describe("delete-merge", () => {
  it("keeps the earlier segment's metadata when a divider is removed", () => {
    const markers = [marker("a", 100), marker("b", 200)];
    const meta = new Map<string, SegmentMeta>([
      [START_ID, { title: "One" }],
      ["a", { title: "Two" }],
      ["b", { title: "Three" }],
    ]);
    // Removing marker b merges the segment it led into the one before it; that earlier segment keeps
    // its own leading id "a", so its title rides along.
    const merged = markers.filter((m) => m.id !== "b");
    const segs = deriveSegments(merged, 300, meta);
    expect(segs).toHaveLength(2);
    expect(segs[1].id).toBe("a");
    expect(segs[1].meta.title).toBe("Two");
    expect(segs[1].end).toBe(300);
  });
});

describe("metadata stability across a drag", () => {
  it("keeps a segment's metadata attached as its leading marker moves", () => {
    const meta = new Map<string, SegmentMeta>([["a", { title: "Kept" }]]);
    const before = deriveSegments([marker("a", 100)], 300, meta);
    expect(before[1].meta.title).toBe("Kept");
    // The same id at a new frame: the metadata stays with the marker, not the position.
    const after = deriveSegments([marker("a", 220)], 300, meta);
    expect(after[1].start).toBe(220);
    expect(after[1].meta.title).toBe("Kept");
  });
});

describe("replaceByOrigin", () => {
  it("replaces only its own origin, leaving manual markers in place", () => {
    const markers = [marker("m", 100, "manual"), marker("s1", 200, "silence"), marker("s2", 300, "silence")];
    const res = replaceByOrigin(markers, new Map(), "silence", [{ frame: 250 }], 500, idGen());
    const origins = res.markers.map((m) => m.origin).sort();
    expect(origins).toEqual(["manual", "silence"]);
    expect(res.markers.find((m) => m.origin === "manual")?.frame).toBe(100);
    expect(res.markers.find((m) => m.origin === "silence")?.frame).toBe(250);
  });

  it("seeds the START segment from an entry at or before the start, placing no marker", () => {
    const res = replaceByOrigin(
      [],
      new Map(),
      "cue",
      [
        { frame: 0, meta: { title: "First", track_no: 1 } },
        { frame: 200, meta: { title: "Second", track_no: 2 } },
      ],
      1000,
      idGen(),
    );
    expect(res.markers).toHaveLength(1);
    expect(res.markers[0].frame).toBe(200);
    expect(res.meta.get(START_ID)?.title).toBe("First");
  });

  it("drops metadata for the origin it replaces", () => {
    const markers = [marker("s1", 200, "silence")];
    const meta = new Map<string, SegmentMeta>([["s1", { title: "Gone" }]]);
    const res = replaceByOrigin(markers, meta, "silence", [], 500, idGen());
    expect(res.markers).toHaveLength(0);
    expect(res.meta.has("s1")).toBe(false);
  });
});

describe("toJobSegments", () => {
  it("maps each derived segment to its frame range and tags, an absent field passing as null", () => {
    const meta = new Map<string, SegmentMeta>([
      [START_ID, { title: "Intro" }],
      ["a", { title: "Two", artist: "Nils", track_no: 2 }],
    ]);
    const segs = deriveSegments([marker("a", 100)], 300, meta);
    expect(toJobSegments(segs)).toEqual([
      { start_frame: 0, end_frame: 100, title: "Intro", artist: null, track_no: null },
      { start_frame: 100, end_frame: 300, title: "Two", artist: "Nils", track_no: 2 },
    ]);
  });
});

describe("pruneMeta", () => {
  it("keeps START and live marker keys, dropping orphans", () => {
    const meta = new Map<string, SegmentMeta>([
      [START_ID, { title: "keep" }],
      ["live", { title: "keep" }],
      ["dead", { title: "drop" }],
    ]);
    const pruned = pruneMeta(meta, [marker("live", 100)]);
    expect([...pruned.keys()].sort()).toEqual([START_ID, "live"]);
  });
});
