// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { nextRepeat, sequenceActive, sequenceGlyph } from "./sequenceState";

describe("sequenceGlyph", () => {
  it("shows the shuffle glyph whenever shuffle is on, over any repeat mode", () => {
    expect(sequenceGlyph("off", true)).toBe("shuffle");
    expect(sequenceGlyph("all", true)).toBe("shuffle");
    expect(sequenceGlyph("one", true)).toBe("shuffle");
  });

  it("shows repeat-one for the current-track repeat when not shuffling", () => {
    expect(sequenceGlyph("one", false)).toBe("repeat-one");
  });

  it("falls back to the plain repeat glyph otherwise", () => {
    expect(sequenceGlyph("off", false)).toBe("repeat");
    expect(sequenceGlyph("all", false)).toBe("repeat");
  });
});

describe("sequenceActive", () => {
  it("is off only when fully default: no shuffle, repeat off", () => {
    expect(sequenceActive("off", false)).toBe(false);
  });

  it("is on when shuffling", () => {
    expect(sequenceActive("off", true)).toBe(true);
  });

  it("is on for any non-off repeat mode", () => {
    expect(sequenceActive("all", false)).toBe(true);
    expect(sequenceActive("one", false)).toBe(true);
  });
});

describe("nextRepeat", () => {
  it("steps off to all", () => {
    expect(nextRepeat("off")).toBe("all");
  });

  it("steps all to one", () => {
    expect(nextRepeat("all")).toBe("one");
  });

  it("steps one back to off", () => {
    expect(nextRepeat("one")).toBe("off");
  });

  it("cycles back to off in three steps", () => {
    expect(nextRepeat(nextRepeat(nextRepeat("off")))).toBe("off");
  });
});
