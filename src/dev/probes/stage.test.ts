// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { clearChildren, gridShift, snapCss, stackingReasons, type StackingStyle } from "./stage";

const plain: StackingStyle = {
  position: "absolute",
  zIndex: "auto",
  opacity: "1",
  transform: "none",
  filter: "none",
  backdropFilter: "none",
  isolation: "auto",
  mixBlendMode: "normal",
  willChange: "auto",
  contain: "none",
};

describe("snapCss", () => {
  it("lands an edge on a whole device pixel", () => {
    expect(snapCss(480, 1.25)).toBe(480);
    expect(snapCss(100.3, 1.25) * 1.25).toBeCloseTo(125);
    expect(snapCss(10, 1)).toBe(10);
  });
});

describe("clearChildren", () => {
  it("removes every child and leaves an empty node alone", () => {
    const kids = ["canvas", "iframe", "div"];
    const node = {
      get firstChild() {
        return kids[0] ?? null;
      },
      removeChild(child: string) {
        kids.splice(kids.indexOf(child), 1);
      },
    };
    clearChildren(node as never);
    expect(kids).toEqual([]);
    clearChildren(node as never);
    expect(kids).toEqual([]);
  });
});

describe("gridShift", () => {
  it.each([1, 1.25, 1.5, 2])("puts an edge on a whole device pixel at dpr %s", (dpr) => {
    for (const edge of [0, 12.3, 24.8, 100.7, 33.33, 477.8, 1.0000001]) {
      const shifted = edge + gridShift(edge, dpr);
      expect(Math.abs(shifted * dpr - Math.round(shifted * dpr))).toBeLessThan(1e-9);
      expect(Math.abs(gridShift(edge, dpr))).toBeLessThanOrEqual(0.5 / dpr + 1e-12);
    }
  });

  it("leaves an edge that is already on the grid alone", () => {
    expect(gridShift(40, 1.25)).toBeCloseTo(0);
    expect(gridShift(10, 1)).toBe(0);
  });

  it("moves the slot of a 1 px bordered panel at dpr 1.25 by a quarter device pixel at most", () => {
    // Panel on the grid at x = 32; the border reads 1 device pixel (0.8 CSS), so the slot sits at 32.8.
    const slot = 32.8;
    expect(Math.abs(gridShift(slot, 1.25))).toBeLessThan(1e-9);
    // A panel at 32.4 puts the slot at 33.2 CSS = 41.5 device px: half a pixel off.
    expect(gridShift(33.2, 1.25) * 1.25).toBeCloseTo(0.5);
  });
});

describe("stackingReasons", () => {
  it("is empty for a plain positioned box", () => {
    expect(stackingReasons(plain)).toEqual([]);
  });

  it("names each property that forms a stacking context", () => {
    expect(stackingReasons({ ...plain, opacity: "0.5" })).toEqual(["opacity 0.5"]);
    expect(stackingReasons({ ...plain, isolation: "isolate" })).toEqual(["isolation"]);
    expect(stackingReasons({ ...plain, transform: "scale(1.5)", filter: "blur(2px)" })).toEqual(["transform", "filter"]);
    expect(stackingReasons({ ...plain, zIndex: "1" })).toEqual(["z-index 1"]);
  });

  it("ignores z-index on a static box", () => {
    expect(stackingReasons({ ...plain, position: "static", zIndex: "3" })).toEqual([]);
  });
});
