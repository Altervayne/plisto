// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { foldActions } from "./foldActions";

// -- Type Imports --
import type { FoldInput, FoldItem } from "./foldActions";

/** The track bar in its display order, every action 100 wide. */
const TRACK: FoldItem[] = [
  { id: "next", width: 100, keep: 2, group: 1 },
  { id: "queue", width: 100, keep: 3, group: 1 },
  { id: "create", width: 100, keep: 1, group: 2 },
  { id: "single", width: 100, keep: 6, group: 2 },
  { id: "album", width: 100, keep: 5, group: 2 },
  { id: "playlist", width: 100, keep: 7, group: 3 },
  { id: "extract", width: 100, keep: 8, group: 4 },
  { id: "tags", width: 100, keep: 4, group: 4 },
  { id: "clean", width: 100, keep: 9, group: 4 },
];

function input(items: FoldItem[], available: number): FoldInput {
  return { items, available, gap: 6, sepWidth: 9, moreWidth: 80, trailingWidth: 60 };
}

describe("foldActions", () => {
  it("folds nothing when the row fits", () => {
    const result = foldActions(input(TRACK, 5000));
    expect(result.folded).toEqual([]);
    expect([...result.separated]).toEqual(["create", "playlist", "extract"]);
  });

  it("folds the highest rank first and keeps display order in the result", () => {
    // All nine fit at 1059; dropping clean (plus More) fits at 1050.
    const result = foldActions(input(TRACK, 1050));
    expect(result.folded).toEqual(["clean"]);
  });

  it("folds extract then clean in the mockup order before anything else", () => {
    const result = foldActions(input(TRACK, 940));
    expect(result.folded).toEqual(["extract", "clean"]);
  });

  it("never folds rank 1, however narrow the row", () => {
    const result = foldActions(input(TRACK, 10));
    expect(result.folded).not.toContain("create");
    expect(result.folded).toHaveLength(TRACK.length - 1);
  });

  it("drops a separator with its group when the group folds away", () => {
    const narrow = foldActions(input(TRACK, 560));
    expect(narrow.folded).toEqual(expect.arrayContaining(["extract", "clean", "tags", "playlist"]));
    expect(narrow.separated.has("playlist")).toBe(false);
    expect(narrow.separated.has("extract")).toBe(false);
    expect(narrow.separated.has("create")).toBe(true);
  });

  it("leaves no leading separator when the first group is absent", () => {
    const noPlay = TRACK.filter((item) => item.group !== 1);
    const result = foldActions(input(noPlay, 5000));
    expect(result.separated.has("create")).toBe(false);
    expect([...result.separated]).toEqual(["playlist", "extract"]);
  });

  it("counts no separators when the row has none", () => {
    const result = foldActions({ ...input(TRACK, 5000), sepWidth: 0 });
    expect(result.separated.size).toBe(0);
  });

  it("breaks rank ties by folding the later action first", () => {
    const items: FoldItem[] = [
      { id: "a", width: 100, keep: 1, group: 1 },
      { id: "b", width: 100, keep: 2, group: 1 },
      { id: "c", width: 100, keep: 2, group: 1 },
    ];
    const result = foldActions({ ...input(items, 0), available: 360 });
    expect(result.folded).toEqual(["c"]);
  });
});
