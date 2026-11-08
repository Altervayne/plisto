// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { armTarget } from "./record";

describe("armTarget", () => {
  it("rests at the lead-in at the start and for unknown progress", () => {
    expect(armTarget(0)).toBeCloseTo(0.965, 6);
    expect(armTarget(null)).toBeCloseTo(0.965, 6);
    expect(armTarget(undefined)).toBeCloseTo(0.965, 6);
  });

  it("reaches the run-out at the end", () => {
    expect(armTarget(1)).toBeCloseTo(0.65, 6);
  });

  it("moves inward in proportion to progress", () => {
    expect(armTarget(0.5)).toBeCloseTo((0.965 + 0.65) / 2, 6);
    expect(armTarget(0.25)).toBeGreaterThan(armTarget(0.75));
  });

  it("clamps progress outside 0..1", () => {
    expect(armTarget(-1)).toBeCloseTo(0.965, 6);
    expect(armTarget(2)).toBeCloseTo(0.65, 6);
  });
});
