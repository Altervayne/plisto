// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { bandResponseDb, responseDb } from "./curve";
import { BANDS } from "./settings";

function gainsWith(band: number, db: number): number[] {
  const gains = new Array<number>(BANDS.length).fill(0);
  gains[band] = db;
  return gains;
}

describe("responseDb", () => {
  it("reads +6 dB at the centre of a +6 dB peak at 1 kHz", () => {
    expect(responseDb(gainsWith(3, 6), 1000)).toBeCloseTo(6, 1);
    expect(Math.abs(responseDb(gainsWith(3, 6), 1000) - 6)).toBeLessThan(0.05);
  });

  it("reads -6 dB at the centre of a -6 dB peak", () => {
    expect(Math.abs(responseDb(gainsWith(3, -6), 1000) + 6)).toBeLessThan(0.05);
  });

  it("is flat for flat gains", () => {
    for (const f of [30, 300, 3000, 20000]) expect(responseDb(gainsWith(0, 0), f)).toBe(0);
  });

  it("leaves a peak's far side near zero", () => {
    expect(Math.abs(responseDb(gainsWith(3, 6), 30))).toBeLessThan(0.5);
    expect(Math.abs(responseDb(gainsWith(3, 6), 20000))).toBeLessThan(0.5);
  });

  it("lifts the low shelf at the bottom and leaves the top alone", () => {
    const gains = gainsWith(0, 6);
    expect(Math.abs(bandResponseDb(BANDS[0], 6, 5) - 6)).toBeLessThan(0.1);
    expect(Math.abs(responseDb(gains, 20000))).toBeLessThan(0.1);
  });

  it("lifts the high shelf at Nyquist and leaves the bottom alone", () => {
    const gains = gainsWith(7, 6);
    expect(Math.abs(bandResponseDb(BANDS[7], 6, 24000) - 6)).toBeLessThan(0.1);
    expect(Math.abs(responseDb(gains, 30))).toBeLessThan(0.1);
  });
});
