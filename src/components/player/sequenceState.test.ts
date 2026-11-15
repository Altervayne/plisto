// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { nextRepeat } from "./sequenceState";

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
