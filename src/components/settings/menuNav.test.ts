// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { menuKeyTarget } from "./menuNav";

describe("menuKeyTarget", () => {
  it("moves down and up without wrapping", () => {
    expect(menuKeyTarget("ArrowDown", 2, 8)).toBe(3);
    expect(menuKeyTarget("ArrowDown", 7, 8)).toBe(7);
    expect(menuKeyTarget("ArrowUp", 2, 8)).toBe(1);
    expect(menuKeyTarget("ArrowUp", 0, 8)).toBe(0);
  });

  it("jumps to the ends", () => {
    expect(menuKeyTarget("Home", 4, 8)).toBe(0);
    expect(menuKeyTarget("End", 4, 8)).toBe(7);
  });

  it("ignores other keys and an empty menu", () => {
    expect(menuKeyTarget("a", 1, 8)).toBeNull();
    expect(menuKeyTarget("Escape", 1, 8)).toBeNull();
    expect(menuKeyTarget("Home", 0, 0)).toBeNull();
  });
});
