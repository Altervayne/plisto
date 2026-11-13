// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { formatReleaseDate } from "./releaseDate";

describe("formatReleaseDate", () => {
  it("formats the stamped day in the app language", () => {
    expect(formatReleaseDate("2026-11-12T23:30:00Z", "en")).toBe("November 12, 2026");
    expect(formatReleaseDate("2026-11-12T23:30:00Z", "fr")).toBe("12 novembre 2026");
  });

  it("returns null for a missing or unreadable date", () => {
    expect(formatReleaseDate(null, "en")).toBeNull();
    expect(formatReleaseDate("", "en")).toBeNull();
    expect(formatReleaseDate("not a date", "en")).toBeNull();
  });
});
