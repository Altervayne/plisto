// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { nextFocus } from "./focusNav";

// A 3-wide, 2-tall grid of 100x60 cells, row-major: indexes 0 1 2 / 3 4 5.
const grid = Array.from({ length: 6 }, (_, i) => ({
  left: (i % 3) * 110,
  top: Math.floor(i / 3) * 70,
  width: 100,
  height: 60,
}));

describe("nextFocus", () => {
  it("moves to the neighbour in the pressed direction", () => {
    expect(nextFocus(grid, 1, "ArrowRight")).toBe(2);
    expect(nextFocus(grid, 1, "ArrowLeft")).toBe(0);
    expect(nextFocus(grid, 1, "ArrowDown")).toBe(4);
    expect(nextFocus(grid, 4, "ArrowUp")).toBe(1);
  });

  it("returns null at an edge", () => {
    expect(nextFocus(grid, 2, "ArrowRight")).toBeNull();
    expect(nextFocus(grid, 0, "ArrowLeft")).toBeNull();
    expect(nextFocus(grid, 0, "ArrowUp")).toBeNull();
    expect(nextFocus(grid, 3, "ArrowDown")).toBeNull();
  });

  it("prefers the aligned item over a nearer one that drifted off the row", () => {
    const rects = [
      { left: 0, top: 0, width: 100, height: 60 },
      { left: 110, top: 50, width: 100, height: 60 },
      { left: 220, top: 0, width: 100, height: 60 },
    ];
    expect(nextFocus(rects, 0, "ArrowRight")).toBe(2);
  });

  it("returns null for an unknown origin or a lone item", () => {
    expect(nextFocus(grid, 9, "ArrowRight")).toBeNull();
    expect(nextFocus([grid[0]], 0, "ArrowRight")).toBeNull();
  });
});
