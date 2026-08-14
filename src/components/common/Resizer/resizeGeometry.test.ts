// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  BAND_MAX_ABS,
  BAND_MIN,
  MAX_ABS,
  MIN_WIDTH,
  bandMaxHeight,
  maxWidth,
  sizeForDrag,
  widthForDrag,
} from "./resizeGeometry";

describe("sizeForDrag", () => {
  it("adds the signed delta to the start", () => {
    expect(sizeForDrag(216, 40, BAND_MIN, BAND_MAX_ABS)).toBe(256);
    expect(sizeForDrag(216, -40, BAND_MIN, BAND_MAX_ABS)).toBe(176);
  });

  it("clamps hard at both bounds", () => {
    expect(sizeForDrag(100, -400, BAND_MIN, BAND_MAX_ABS)).toBe(BAND_MIN);
    expect(sizeForDrag(400, 400, BAND_MIN, BAND_MAX_ABS)).toBe(BAND_MAX_ABS);
  });
});

describe("widthForDrag", () => {
  it("widens on a leftward drag and narrows on a rightward drag", () => {
    // The handle is at the panel's left edge: dragging left (negative delta) grows the panel.
    expect(widthForDrag(380, -40, MIN_WIDTH, MAX_ABS)).toBe(420);
    expect(widthForDrag(380, 40, MIN_WIDTH, MAX_ABS)).toBe(340);
  });

  it("clamps hard at the minimum", () => {
    expect(widthForDrag(340, 200, MIN_WIDTH, MAX_ABS)).toBe(MIN_WIDTH);
  });

  it("clamps hard at the maximum", () => {
    expect(widthForDrag(500, -200, MIN_WIDTH, MAX_ABS)).toBe(MAX_ABS);
  });

  it("never returns outside the bounds across a wide drag range", () => {
    for (let delta = -1000; delta <= 1000; delta += 50) {
      const w = widthForDrag(380, delta, MIN_WIDTH, MAX_ABS);
      expect(w).toBeGreaterThanOrEqual(MIN_WIDTH);
      expect(w).toBeLessThanOrEqual(MAX_ABS);
    }
  });
});

describe("maxWidth", () => {
  it("picks the container-relative bound when the container is narrow", () => {
    // 44% of 1000 is 440, tighter than the absolute cap.
    expect(maxWidth(1000)).toBe(440);
  });

  it("picks the absolute cap when the container is wide", () => {
    // 44% of 2000 is 880, so the absolute cap holds.
    expect(maxWidth(2000)).toBe(MAX_ABS);
  });

  it("rounds the container-relative bound", () => {
    // 44% of 999 is 439.56, rounded.
    expect(maxWidth(999)).toBe(440);
  });

  it("never drops below the minimum on a narrow window", () => {
    // 44% of 485 is 213, under MIN_WIDTH: the floor wins so the bound cannot invert.
    expect(maxWidth(485)).toBe(MIN_WIDTH);
  });
});

describe("bandMaxHeight", () => {
  it("picks the nav-relative bound when the column is short", () => {
    // 60% of 600 is 360, tighter than the absolute cap.
    expect(bandMaxHeight(600)).toBe(360);
  });

  it("picks the absolute cap when the column is tall", () => {
    // 60% of 1200 is 720, so the absolute cap holds.
    expect(bandMaxHeight(1200)).toBe(BAND_MAX_ABS);
  });

  it("rounds the nav-relative bound", () => {
    // 60% of 599 is 359.4, rounded.
    expect(bandMaxHeight(599)).toBe(359);
  });

  it("never drops below the minimum in a short column", () => {
    // 60% of 100 is 60, under BAND_MIN: the floor wins so the bound cannot invert.
    expect(bandMaxHeight(100)).toBe(BAND_MIN);
  });
});
