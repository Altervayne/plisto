import { describe, expect, it } from "vitest";

import { FAR_JUMP, WINDOW_RADIUS, isFarJump, layoutLabels, place, windowRange, zIndexOf } from "./shelfLayout";

const CS = 200;
const flat = new Array(100).fill(0);

describe("windowRange", () => {
  it("is centred in the middle", () => {
    expect(windowRange(50, 100)).toEqual({ lo: 50 - WINDOW_RADIUS, hi: 50 + WINDOW_RADIUS });
  });

  it("clamps at both ends", () => {
    expect(windowRange(0, 100)).toEqual({ lo: 0, hi: WINDOW_RADIUS });
    expect(windowRange(99, 100)).toEqual({ lo: 99 - WINDOW_RADIUS, hi: 99 });
  });

  it("covers a short list and an empty one", () => {
    expect(windowRange(1, 3)).toEqual({ lo: 0, hi: 2 });
    const e = windowRange(0, 0);
    expect(e.lo).toBeGreaterThan(e.hi);
  });

  it("holds 25 at most", () => {
    const { lo, hi } = windowRange(2000, 5000);
    expect(hi - lo + 1).toBe(25);
  });
});

describe("isFarJump", () => {
  it("is true past the threshold only", () => {
    expect(isFarJump(0, FAR_JUMP)).toBe(false);
    expect(isFarJump(0, FAR_JUMP + 1)).toBe(true);
    expect(isFarJump(40, 20)).toBe(true);
  });
});

describe("place", () => {
  it("puts the focus at rest", () => {
    const p = place(5, 5, flat, CS, false);
    expect(p).toMatchObject({ x: 0, z: -0, ry: -0, s: 1, veil: 0 });
  });

  it("is symmetric around the focus", () => {
    for (const reduced of [false, true]) {
      for (const d of [1, 2, 7]) {
        const l = place(50 - d, 50, flat, CS, reduced);
        const r = place(50 + d, 50, flat, CS, reduced);
        expect(l.x).toBeCloseTo(-r.x);
        expect(l.z).toBeCloseTo(r.z);
        expect(l.ry).toBeCloseTo(-r.ry);
        expect(l.veil).toBeCloseTo(r.veil);
      }
    }
  });

  it("recedes monotonically with distance", () => {
    let prev = place(50, 50, flat, CS, false);
    for (let d = 1; d <= 12; d++) {
      const p = place(50 + d, 50, flat, CS, false);
      expect(p.x).toBeGreaterThan(prev.x);
      expect(p.z).toBeLessThanOrEqual(prev.z);
      expect(p.veil).toBeGreaterThanOrEqual(prev.veil);
      prev = p;
    }
  });

  it("caps the veil", () => {
    expect(place(99, 0, flat, CS, false).veil).toBe(0.82);
    expect(place(99, 0, flat, CS, true).veil).toBe(0.5);
  });

  it("adds a gap and depth per group boundary", () => {
    const groups = [0, 0, 0, 1, 1, 1];
    const a = place(4, 2, flat, CS, false);
    const b = place(4, 2, groups, CS, false);
    expect(b.x - a.x).toBeCloseTo(0.42 * CS);
    expect(b.z - a.z).toBeCloseTo(-14);
  });

  it("lays a flat strip under reduced motion", () => {
    const p = place(52, 50, flat, CS, true);
    expect(p.z).toBe(0);
    expect(p.ry).toBe(0);
    expect(p.s).toBeLessThan(1);
    expect(p.transform).not.toContain("rotateY");
  });

  it("stacks the focus on top", () => {
    expect(zIndexOf(5, 5)).toBeGreaterThan(zIndexOf(6, 5));
    expect(zIndexOf(4, 5)).toBe(zIndexOf(6, 5));
  });
});

describe("layoutLabels", () => {
  const groupOf = [0, 0, 0, 1, 1, 1, 1, 2];
  const placed = (i: number) => place(i, 2, groupOf, CS, false);

  it("lays one label per start and bounds each by the next", () => {
    const labels = layoutLabels([0, 3, 7], placed, 2, groupOf, CS, false);
    expect(labels.map((l) => l.start)).toEqual([0, 3, 7]);
    expect(labels.map((l) => l.current)).toEqual([true, false, false]);
    expect(labels[0].maxWidth).toBeGreaterThanOrEqual(28);
    expect(labels[2].maxWidth).toBe(CS * 1.6);
  });

  it("keeps the opacity floor", () => {
    const labels = layoutLabels([7], placed, 2, groupOf, CS, false);
    expect(labels[0].opacity).toBeGreaterThanOrEqual(0.42);
  });

  it("drops the tilt under reduced motion", () => {
    const labels = layoutLabels([0], (i) => place(i, 2, groupOf, CS, true), 2, groupOf, CS, true);
    expect(labels[0].transform).not.toContain("rotateY");
  });
});
