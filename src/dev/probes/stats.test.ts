// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { clockStep, maxOf, mean, median, percentile, perItemMs } from "./stats";

describe("stats", () => {
  it("takes the median of odd and even counts, and 0 of nothing", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("takes percentiles by nearest rank", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 99)).toBe(10);
    expect(percentile(ten, 0)).toBe(1);
    expect(percentile([], 99)).toBe(0);
  });

  it("takes the max and the mean", () => {
    expect(maxOf([2, 9, 4])).toBe(9);
    expect(mean([2, 4])).toBe(3);
    expect(mean([])).toBe(0);
  });

  it("divides batch times into per-item times", () => {
    expect(perItemMs([10, 20], 10)).toEqual([1, 2]);
    expect(perItemMs([10], 0)).toEqual([]);
  });

  it("reports the smallest step between distinct clock readings", () => {
    expect(clockStep([1, 1, 1.1, 1.3, 1.3])).toBeCloseTo(0.1);
    expect(clockStep([5, 5])).toBe(0);
  });
});
