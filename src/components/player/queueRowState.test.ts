// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  blockPlace,
  queueRowState,
  queueSegments,
  resolveQueueReorder,
  upNextCount,
} from "./queueRowState";

describe("queueSegments", () => {
  it("leaves a queue with no blocks as loose rows", () => {
    expect(queueSegments(2, [])).toEqual([
      { kind: "row", index: 0 },
      { kind: "row", index: 1 },
    ]);
  });

  it("cuts a block out of the rows around it", () => {
    expect(queueSegments(5, [[1, 3]])).toEqual([
      { kind: "row", index: 0 },
      { kind: "block", start: 1, length: 3 },
      { kind: "row", index: 4 },
    ]);
  });

  it("gives a run of one row no band", () => {
    expect(queueSegments(3, [[1, 1]]).every((s) => s.kind === "row")).toBe(true);
  });

  it("orders blocks by start and skips an overlapping or out-of-range span", () => {
    const segments = queueSegments(6, [[3, 3], [0, 2], [1, 2], [5, 4]]);
    expect(segments).toEqual([
      { kind: "block", start: 0, length: 2 },
      { kind: "row", index: 2 },
      { kind: "block", start: 3, length: 3 },
    ]);
  });
});

describe("blockPlace", () => {
  it("is the cursor's 1-based place inside the block", () => {
    expect(blockPlace(2, 9, 6)).toBe(5);
    expect(blockPlace(2, 9, 2)).toBe(1);
    expect(blockPlace(2, 9, 10)).toBe(9);
  });

  it("is null with the cursor outside the block", () => {
    expect(blockPlace(2, 9, 1)).toBeNull();
    expect(blockPlace(2, 9, 11)).toBeNull();
  });
});

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

describe("queueRowState under a stream", () => {
  it("marks the cursor row parked, never now", () => {
    expect(queueRowState(2, 2, { parked: true })).toBe("parked");
    expect(queueRowState(1, 2, { parked: true })).toBe("played");
    expect(queueRowState(3, 2, { parked: true })).toBe("next");
  });

  it("reads the cursor row as next when nothing is parked", () => {
    expect(queueRowState(2, 2, { parked: false })).toBe("next");
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
