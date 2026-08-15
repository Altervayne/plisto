// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { reorderSlots } from "./playlistOrder";

describe("reorderSlots", () => {
  it("drops a slot dragged downward after the over slot", () => {
    expect(reorderSlots([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4]);
  });

  it("drops a slot dragged upward before the over slot", () => {
    expect(reorderSlots([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
  });

  it("moves onto an adjacent slot", () => {
    expect(reorderSlots([1, 2, 3], 1, 2)).toEqual([2, 1, 3]);
    expect(reorderSlots([1, 2, 3], 3, 2)).toEqual([1, 3, 2]);
  });

  it("keeps a repeated track's slots independent", () => {
    // Two slots (10, 30) carry the same track; reordering keys on the slot id alone.
    expect(reorderSlots([10, 20, 30], 30, 10)).toEqual([30, 10, 20]);
  });

  it("returns the input unchanged for a no-op or an absent id", () => {
    expect(reorderSlots([1, 2, 3], 2, 2)).toEqual([1, 2, 3]);
    expect(reorderSlots([1, 2, 3], 9, 2)).toEqual([1, 2, 3]);
    expect(reorderSlots([1, 2, 3], 2, 9)).toEqual([1, 2, 3]);
  });
});
