// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { foldToThirds, smoothBands } from "./spectrum";

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

describe("foldToThirds", () => {
  it("takes the max of each third of a full frame", () => {
    // Nine bands split into three thirds; each third reports its peak, not its mean.
    const bands = [0.1, 0.9, 0.2, 0.3, 0.3, 0.4, 0.8, 0.1, 0.5];
    expect(foldToThirds(bands)).toEqual([0.9, 0.4, 0.8]);
  });

  it("gives the remainder to the last third when the count divides unevenly", () => {
    // Eight bands: thirds start at 0, 2, 5 (floor of g x 8/3), the last taking bands 5..8.
    const bands = [0.2, 0.1, 0.4, 0.3, 0.2, 0.9, 0.1, 0.6];
    expect(foldToThirds(bands)).toEqual([0.2, 0.4, 0.9]);
  });

  it("yields three zeros for an empty frame", () => {
    expect(foldToThirds([])).toEqual([0, 0, 0]);
  });
});
