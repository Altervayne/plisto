// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { queueRowState, resolveQueueReorder, upNextCount } from "./queueRowState";

describe("queueRowState", () => {
  it("marks rows behind the cursor as played", () => {
    expect(queueRowState(0, 2)).toBe("played");
    expect(queueRowState(1, 2)).toBe("played");
  });

  it("marks the row on the cursor as now", () => {
    expect(queueRowState(2, 2)).toBe("now");
  });

  it("marks rows ahead of the cursor as next", () => {
    expect(queueRowState(3, 2)).toBe("next");
    expect(queueRowState(9, 2)).toBe("next");
  });

  it("treats a fresh queue at the head as now for the first row", () => {
    expect(queueRowState(0, 0)).toBe("now");
    expect(queueRowState(1, 0)).toBe("next");
  });
});

describe("upNextCount", () => {
  it("counts the rows ahead of the cursor", () => {
    expect(upNextCount(5, 0)).toBe(4);
    expect(upNextCount(5, 2)).toBe(2);
  });

  it("is zero on the last row", () => {
    expect(upNextCount(5, 4)).toBe(0);
  });

  it("never goes negative on a stopped or empty queue", () => {
    expect(upNextCount(0, 0)).toBe(0);
    expect(upNextCount(3, 5)).toBe(0);
  });
});

describe("resolveQueueReorder", () => {
  it("moves an up-next row to a later up-next slot", () => {
    // Cursor at 1; drag slot 2 onto slot 4.
    expect(resolveQueueReorder(2, 4, 1)).toEqual({ from: 2, to: 4 });
  });

  it("clamps a drop above the cursor to the first up-next slot", () => {
    // Cursor at 2; a drop onto the now row (2) or a played row (0) lands just past the cursor.
    expect(resolveQueueReorder(5, 0, 2)).toEqual({ from: 5, to: 3 });
    expect(resolveQueueReorder(5, 2, 2)).toEqual({ from: 5, to: 3 });
  });

  it("no-ops a drop that would not shift the row", () => {
    expect(resolveQueueReorder(3, 3, 1)).toBeNull();
    // Clamps to 3, which equals the source, so nothing moves.
    expect(resolveQueueReorder(3, 1, 2)).toBeNull();
  });

  it("no-ops a played or now-playing source, or a drop outside any target", () => {
    expect(resolveQueueReorder(1, 4, 1)).toBeNull();
    expect(resolveQueueReorder(0, 4, 1)).toBeNull();
    expect(resolveQueueReorder(-1, 4, 1)).toBeNull();
    expect(resolveQueueReorder(3, -1, 1)).toBeNull();
  });
});
