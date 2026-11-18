// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { HOLD_SWELL, MOTION_CAP, heldSignal } from "./labHold";

const LEVEL = 0.4;
const MOTION_FIELDS = ["bassMotion", "midMotion", "highMotion"] as const;
const HIT_FIELDS = ["bassHit", "midHit", "highHit"] as const;
const TRANSIENT_FIELDS = [...HIT_FIELDS, "beatWeight", "surge", "cut"] as const;
const RUN_FRAMES = 360;
const SETTLE_FRAMES = 120;

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

  it("holds the loudness equal to the level in every run", () => {
    for (const run of ["capped", "rest", "calmRest"] as const) expect(heldSignal(LEVEL, run, 7).loudness).toBe(LEVEL);
  });

  it("puts the hits at the cap and weights each beat at the cap in the capped run", () => {
    const sig = heldSignal(LEVEL, "capped", 5);
    for (const field of HIT_FIELDS) expect(sig[field]).toBe(MOTION_CAP);
    expect(sig.beatWeight).toBe(0);
    expect(heldSignal(LEVEL, "capped", 0).beatWeight).toBe(MOTION_CAP);
    expect(heldSignal(LEVEL, "capped", 20).beatWeight).toBe(MOTION_CAP);
  });

  it("fires one surge and one cut at the cap inside the measured frames of the capped run", () => {
    const surges: number[] = [];
    const cuts: number[] = [];
    for (let i = 0; i < RUN_FRAMES; i++) {
      const sig = heldSignal(LEVEL, "capped", i);
      if (sig.surge > 0) surges.push(i);
      if (sig.cut > 0) cuts.push(i);
      if (sig.surge > 0) expect(sig.surge).toBe(MOTION_CAP);
      if (sig.cut > 0) expect(sig.cut).toBe(MOTION_CAP);
    }
    expect(surges).toHaveLength(1);
    expect(cuts).toHaveLength(1);
    expect(surges[0]).toBeGreaterThanOrEqual(SETTLE_FRAMES);
    expect(cuts[0]).toBeGreaterThanOrEqual(SETTLE_FRAMES);
  });

  it("holds every transient field at 0 in the rest and calm rest runs", () => {
    for (const run of ["rest", "calmRest"] as const) {
      for (let i = 0; i < RUN_FRAMES; i++) {
        const sig = heldSignal(LEVEL, run, i);
        for (const field of TRANSIENT_FIELDS) expect(sig[field]).toBe(0);
      }
    }
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
