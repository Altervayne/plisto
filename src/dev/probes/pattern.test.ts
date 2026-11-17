// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import "./fixtures/pattern.js";
import { buildMask, comparisonPlan } from "./pixelDiff";

// The stage slot: 480 x 270 CSS px less the panel's 1 px border on each side.
const SLOT_W = 478;
const SLOT_H = 268;

describe("blend pattern", () => {
  const pattern = globalThis.probePattern;

  it("fits the stage slot whole, so one view shows every patch", () => {
    const size = pattern.size();
    expect(size.width).toBeLessThanOrEqual(SLOT_W);
    expect(size.height).toBeLessThanOrEqual(SLOT_H);
    for (const p of pattern.patches()) {
      expect(p.x + p.w).toBeLessThanOrEqual(size.width);
      expect(p.y + p.h).toBeLessThanOrEqual(size.height);
    }
  });

  it("has eight colors at four alphas, flat patches at least 40 CSS px wide", () => {
    const patches = pattern.patches();
    expect(patches).toHaveLength(32);
    expect(new Set(patches.map((p) => p.alpha))).toEqual(new Set([0, 0.25, 0.5, 1]));
    for (const p of patches) expect(p.w).toBeGreaterThanOrEqual(40);
  });

  it("leaves a compared interior in every patch at device and at DIP scale", () => {
    for (const [captureWidth, dpr] of [
      [1000, 1.25],
      [800, 1.25],
      [800, 1],
      [1600, 2],
    ]) {
      const plan = comparisonPlan(captureWidth, 800, dpr);
      const scale = plan.scale;
      const size = pattern.size();
      const w = Math.round(size.width * scale);
      const h = Math.round(size.height * scale);
      const rects = pattern.patches().map((p) => ({
        x: Math.round(p.x * scale),
        y: Math.round(p.y * scale),
        w: Math.round(p.w * scale),
        h: Math.round(p.h * scale),
      }));
      const mask = buildMask(w, h, rects, plan.margin);
      for (const r of rects) {
        const center = (r.y + (r.h >> 1)) * w + r.x + (r.w >> 1);
        expect(mask[center]).toBe(1);
      }
    }
  });

  it("never uses the registration color", () => {
    for (const [r, g, b] of pattern.COLORS) expect(r >= 230 && g <= 25 && b >= 230).toBe(false);
  });
});
