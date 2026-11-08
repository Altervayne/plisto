import { describe, expect, it } from "vitest";
import { beatSpot } from "./pond";

describe("beatSpot", () => {
  it("stays inside the pane margins", () => {
    for (let n = 1; n < 200; n++) {
      const [x, y] = beatSpot(n);
      expect(x).toBeGreaterThanOrEqual(0.1);
      expect(x).toBeLessThanOrEqual(0.9);
      expect(y).toBeGreaterThanOrEqual(0.12);
      expect(y).toBeLessThanOrEqual(0.88);
    }
  });

  it("does not repeat a spot", () => {
    const seen = new Set<string>();
    for (let n = 1; n < 100; n++) seen.add(beatSpot(n).join(","));
    expect(seen.size).toBe(99);
  });
});
