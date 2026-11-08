// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { coverPixelState, type CoverPixelState } from "./useCoverPixels";

describe("coverPixelState", () => {
  const cases: [string, string | null, string | null, string | null, CoverPixelState][] = [
    ["no src", null, null, null, "absent"],
    ["no src, a bitmap still held", null, "a", null, "absent"],
    ["first read under way", "a", null, null, "pending"],
    ["its own bitmap held", "a", "a", null, "ready"],
    ["a new src over the previous bitmap", "b", "a", null, "pending"],
    ["its read failed", "a", null, "a", "absent"],
    ["another src failed", "b", null, "a", "pending"],
    ["held after a failed read of the same src", "a", "a", "a", "ready"],
  ];

  it.each(cases)("%s", (_, src, loadedSrc, failedSrc, expected) => {
    expect(coverPixelState(src, loadedSrc, failedSrc)).toBe(expected);
  });
});
