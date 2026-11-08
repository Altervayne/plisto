import { describe, expect, it } from "vitest";
import { easeHigh } from "./lake";

describe("easeHigh", () => {
  it("rises faster than it falls", () => {
    const up = easeHigh(0, 1, 0.1);
    const down = 1 - easeHigh(1, 0, 0.1);
    expect(up).toBeGreaterThan(down * 2);
  });

  it("stays inside 0..1", () => {
    expect(easeHigh(0.5, 3, 1)).toBeLessThanOrEqual(1);
    expect(easeHigh(0.5, -2, 1)).toBeGreaterThanOrEqual(0);
  });
});
