// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { ACTIVE_TOP_OFFSET, activeSectionIndex } from "./activeSection";

const tops = [0, 400, 900, 1500, 1800];

describe("activeSectionIndex", () => {
  it("starts on the first section", () => {
    expect(activeSectionIndex(tops, 0, 500, 2000)).toBe(0);
  });

  it("switches once a top passes the offset line", () => {
    expect(activeSectionIndex(tops, 400 - ACTIVE_TOP_OFFSET - 1, 500, 2400)).toBe(0);
    expect(activeSectionIndex(tops, 400 - ACTIVE_TOP_OFFSET, 500, 2400)).toBe(1);
  });

  it("takes the last section whose top has passed", () => {
    expect(activeSectionIndex(tops, 1000, 500, 2400)).toBe(2);
  });

  it("activates the last section at the end of the page though it never reaches the line", () => {
    // Scrolled to the end at 1500: the last top (1800) is still below the offset line.
    expect(activeSectionIndex(tops, 1500, 500, 2000)).toBe(4);
  });

  it("accepts an end position a fraction short", () => {
    expect(activeSectionIndex(tops, 1499, 500, 2000)).toBe(4);
  });

  it("stays on the first section when the page does not scroll", () => {
    expect(activeSectionIndex(tops, 0, 2000, 2000)).toBe(0);
  });

  it("returns 0 for no sections", () => {
    expect(activeSectionIndex([], 100, 500, 2000)).toBe(0);
  });
});
