// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { FOLD_MAX_WIDTH, isFolded, transportOrder } from "./useFoldedRow";

describe("transport fold order", () => {
  it("folds at the container query width and below", () => {
    expect(isFolded(FOLD_MAX_WIDTH)).toBe(true);
    expect(isFolded(FOLD_MAX_WIDTH + 1)).toBe(false);
  });

  it("keeps Sound first at normal width", () => {
    expect(transportOrder(false)).toEqual(["sound", "cluster", "volume"]);
  });

  it("puts the first line before the second line when folded", () => {
    expect(transportOrder(true)).toEqual(["cluster", "sound", "volume"]);
  });
});
