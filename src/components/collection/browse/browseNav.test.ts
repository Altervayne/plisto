import { describe, expect, it } from "vitest";

import { jumpGroup, stepFocus } from "./browseNav";
import type { BrowseShape } from "./browseNav";

// Ten records in three groups starting at 0, 4 and 7.
const grouped: BrowseShape = {
  count: 10,
  groups: [{ start: 0 }, { start: 4 }, { start: 7 }],
  groupOf: [0, 0, 0, 0, 1, 1, 1, 2, 2, 2],
};
const flat: BrowseShape = { count: 30, groups: [], groupOf: new Array(30).fill(0) };
const none: BrowseShape = { count: 0, groups: [], groupOf: [] };

describe("stepFocus", () => {
  it("moves and clamps at both ends", () => {
    expect(stepFocus(grouped, 3, 1)).toBe(4);
    expect(stepFocus(grouped, 0, -1)).toBe(0);
    expect(stepFocus(grouped, 9, 1)).toBe(9);
    expect(stepFocus(grouped, 5, 100)).toBe(9);
  });

  it("stays at 0 when empty", () => {
    expect(stepFocus(none, 0, 1)).toBe(0);
  });
});

describe("jumpGroup", () => {
  it("goes to the next group start", () => {
    expect(jumpGroup(grouped, 1, 1)).toBe(4);
    expect(jumpGroup(grouped, 4, 1)).toBe(7);
  });

  it("goes to the last record from the final group", () => {
    expect(jumpGroup(grouped, 7, 1)).toBe(9);
  });

  it("goes back to this group start, then the previous one", () => {
    expect(jumpGroup(grouped, 6, -1)).toBe(4);
    expect(jumpGroup(grouped, 4, -1)).toBe(0);
    expect(jumpGroup(grouped, 0, -1)).toBe(0);
  });

  it("moves a page when ungrouped", () => {
    expect(jumpGroup(flat, 5, 1)).toBe(15);
    expect(jumpGroup(flat, 5, -1)).toBe(0);
    expect(jumpGroup(flat, 25, 1)).toBe(29);
  });

  it("stays at 0 when empty", () => {
    expect(jumpGroup(none, 0, 1)).toBe(0);
  });
});
