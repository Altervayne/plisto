// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { HOLD_SWELL, MOTION_CAP, heldSignal } from "./labHold";

const LEVEL = 0.4;
const MOTION_FIELDS = ["bassMotion", "midMotion", "highMotion"] as const;

describe("heldSignal", () => {
  it("holds the level and swell in every run", () => {
    for (const run of ["capped", "rest", "calmRest"] as const) {
      const sig = heldSignal(LEVEL, run, 7);
      expect(sig.level).toBe(LEVEL);
      expect(sig.rms).toBe(LEVEL);
      expect(sig.swell).toBe(HOLD_SWELL);
    }
  });

  it("puts every envelope and the drive at the cap in the capped run", () => {
    const sig = heldSignal(LEVEL, "capped", 3);
    for (const field of MOTION_FIELDS) expect(sig[field]).toBe(MOTION_CAP);
    expect(sig.drive).toBe(MOTION_CAP);
  });

  it("fires a beat on the first frame of each beat period only in the capped run", () => {
    expect(heldSignal(LEVEL, "capped", 0).beat).toBe(MOTION_CAP);
    expect(heldSignal(LEVEL, "capped", 20).beat).toBe(MOTION_CAP);
    expect(heldSignal(LEVEL, "capped", 5).beat).toBe(0);
    expect(heldSignal(LEVEL, "rest", 0).beat).toBe(0);
    expect(heldSignal(LEVEL, "calmRest", 20).beat).toBe(0);
  });

  it("keeps the rest run at the capped run's drive with no motion, beats or loud bands", () => {
    const rest = heldSignal(LEVEL, "rest", 0);
    const capped = heldSignal(LEVEL, "capped", 0);
    expect(rest.drive).toBe(capped.drive);
    for (const field of MOTION_FIELDS) expect(rest[field]).toBe(0);
    expect(rest.kick).toBe(0);
    expect(rest.flux).toBe(0);
    expect(Math.max(...rest.bands)).toBeLessThan(Math.max(...capped.bands));
  });

  it("differs between the rest and calm rest runs only in the drive", () => {
    const rest = heldSignal(LEVEL, "rest", 4);
    const calm = heldSignal(LEVEL, "calmRest", 4);
    expect(calm.drive).toBe(0);
    expect({ ...calm, drive: rest.drive }).toEqual(rest);
  });
});
