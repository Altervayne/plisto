// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { queueRowState, upNextCount } from "./queueRowState";

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
