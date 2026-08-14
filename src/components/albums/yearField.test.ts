// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { formatYear, parseYear } from "./yearField";

describe("parseYear", () => {
  it("reads a plain year", () => {
    expect(parseYear("1971")).toBe(1971);
  });

  it("trims surrounding whitespace", () => {
    expect(parseYear("  1984 ")).toBe(1984);
  });

  it("clears a blank entry to null", () => {
    expect(parseYear("")).toBeNull();
    expect(parseYear("   ")).toBeNull();
  });

  it("clears a non-numeric entry to null", () => {
    expect(parseYear("abc")).toBeNull();
    expect(parseYear("19x1")).toBeNull();
    expect(parseYear("-5")).toBeNull();
  });
});

describe("formatYear", () => {
  it("renders a set year", () => {
    expect(formatYear(1971)).toBe("1971");
  });

  it("renders an unset year as an empty string", () => {
    expect(formatYear(null)).toBe("");
  });
});
