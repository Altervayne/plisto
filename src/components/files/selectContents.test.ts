// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { allSelected, gatherMode } from "./selectContents";

describe("gatherMode", () => {
  it("replaces on a plain click", () => {
    expect(gatherMode({ ctrlKey: false, metaKey: false })).toBe("replace");
  });

  it("adds on Ctrl or Cmd", () => {
    expect(gatherMode({ ctrlKey: true, metaKey: false })).toBe("add");
    expect(gatherMode({ ctrlKey: false, metaKey: true })).toBe("add");
  });
});

describe("allSelected", () => {
  it("needs a non-empty set fully inside the selection", () => {
    expect(allSelected([1, 2], new Set([1, 2, 3]))).toBe(true);
    expect(allSelected([1, 4], new Set([1, 2, 3]))).toBe(false);
    expect(allSelected([], new Set([1]))).toBe(false);
  });
});
