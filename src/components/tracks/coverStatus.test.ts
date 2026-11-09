// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { coverStatus, type CoverStatus } from "./coverStatus";

describe("coverStatus", () => {
  const cases: [string, number | null, boolean, boolean, CoverStatus][] = [
    ["before the first load", null, true, false, "pending"],
    ["the previous track's finished load", 1, false, false, "pending"],
    ["the previous track's cover kept over the next track", 1, false, true, "pending"],
    ["its own load under way", 2, true, false, "pending"],
    ["its own load under way, a cover held", 2, true, true, "pending"],
    ["its own load done, no cover", 2, false, false, "coverless"],
    ["its own load done, a cover", 2, false, true, "present"],
  ];

  it.each(cases)("%s", (_, coverFor, loading, hasCover, expected) => {
    expect(coverStatus(2, coverFor, loading, hasCover)).toBe(expected);
  });
});
