// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  BLOOM_ANCHORS,
  JITTER,
  RADIUS,
  RADIUS_SPREAD,
  STAFF_COLORS,
  STRENGTH_SPREAD,
  seedLayout,
  seedPalette,
} from "./coverSeed";

const IDS = Array.from({ length: 200 }, (_, i) => i + 1);

describe("seedLayout", () => {
  it("is deterministic per track id", () => {
    expect(seedLayout(42)).toEqual(seedLayout(42));
  });

  it("differs across ids", () => {
    const seen = new Set(IDS.map((id) => JSON.stringify(seedLayout(id))));
    expect(seen.size).toBe(IDS.length);
  });

  it("keeps every bloom within the jitter bounds of its anchor", () => {
    for (const id of IDS) {
      seedLayout(id).blooms.forEach((b, i) => {
        const [ax, ay] = BLOOM_ANCHORS[i];
        expect(Math.abs(b.x - ax)).toBeLessThanOrEqual(JITTER);
        expect(Math.abs(b.y - ay)).toBeLessThanOrEqual(JITTER);
        expect(Math.abs(b.r - RADIUS)).toBeLessThanOrEqual(RADIUS_SPREAD);
        expect(Math.abs(b.a - 1)).toBeLessThanOrEqual(STRENGTH_SPREAD);
      });
    }
  });

  it("uses each staff colour exactly once", () => {
    for (const id of IDS) {
      const colors = seedLayout(id).blooms.map((b) => b.color.join(","));
      expect(colors.sort()).toEqual(STAFF_COLORS.map((c) => c.join(",")).sort());
    }
  });

  it("takes the palette from the three strongest blooms by strength times radius", () => {
    for (const id of IDS) {
      const { blooms, palette } = seedLayout(id);
      const ranked = [...blooms].sort((p, q) => q.a * q.r - p.a * p.r).map((b) => b.color);
      expect(palette).toEqual(ranked.slice(0, 3));
      expect(seedPalette(id)).toEqual(palette);
    }
  });
});
