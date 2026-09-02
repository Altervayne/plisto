// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { smoothBands } from "./spectrum";

describe("smoothBands", () => {
  it("rises fast toward a higher target by the attack fraction", () => {
    // From 0 toward 1 at attack 0.5: half the gap this frame.
    const next = smoothBands([0, 0], [1, 1], 0.5, 0.1);
    expect(next).toEqual([0.5, 0.5]);
  });

  it("eases slow toward a lower target by the decay fraction", () => {
    // From 1 toward 0 at decay 0.1: a tenth of the gap this frame.
    const next = smoothBands([1, 1], [0, 0], 0.5, 0.1);
    expect(next[0]).toBeCloseTo(0.9);
    expect(next[1]).toBeCloseTo(0.9);
  });

  it("attacks and decays per band in the same frame", () => {
    // Band 0 rises (attack), band 1 falls (decay).
    const next = smoothBands([0, 1], [1, 0], 0.5, 0.25);
    expect(next[0]).toBeCloseTo(0.5);
    expect(next[1]).toBeCloseTo(0.75);
  });

  it("restarts from a zero frame when the lengths differ", () => {
    // A one-band prev cannot blend into a two-band target, so it starts from zeros and attacks up.
    const next = smoothBands([1], [1, 1], 0.5, 0.1);
    expect(next).toEqual([0.5, 0.5]);
  });
});
