// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  ABSOLUTE_CEIL,
  anchorScrollLeft,
  clampPxPerSec,
  fitPxPerSec,
  formatVisible,
  maxPxPerSec,
  secondsVisible,
  stepPxPerSec,
  ZOOM_STEP,
} from "./zoomModel";

describe("fitPxPerSec", () => {
  it("fits the whole file across the viewport", () => {
    expect(fitPxPerSec(1000, 200)).toBe(5);
  });

  it("has no scale before a viewport or duration exists", () => {
    expect(fitPxPerSec(0, 200)).toBe(0);
    expect(fitPxPerSec(1000, 0)).toBe(0);
  });
});

describe("maxPxPerSec", () => {
  it("caps a long file at the canvas-safe width", () => {
    // 16384 / 8000 = 2.048 px/s, well under the ceiling.
    expect(maxPxPerSec(8000, fitPxPerSec(1000, 8000))).toBeCloseTo(2.048, 3);
  });

  it("caps a short file at the absolute ceiling", () => {
    // 16384 / 30 = 546 px/s would clear the ceiling, so the ceiling wins.
    expect(maxPxPerSec(30, fitPxPerSec(1000, 30))).toBe(ABSOLUTE_CEIL);
  });

  it("never drops below fit for a file too short to zoom", () => {
    const fit = fitPxPerSec(1000, 2);
    expect(maxPxPerSec(2, fit)).toBe(fit);
  });
});

describe("clampPxPerSec", () => {
  it("holds a value inside the bounds", () => {
    expect(clampPxPerSec(50, 5, 400)).toBe(50);
  });

  it("floors at fit and ceils at max", () => {
    expect(clampPxPerSec(1, 5, 400)).toBe(5);
    expect(clampPxPerSec(9000, 5, 400)).toBe(400);
  });
});

describe("stepPxPerSec", () => {
  it("scales geometrically in and out", () => {
    expect(stepPxPerSec(10, 1)).toBeCloseTo(10 * ZOOM_STEP, 6);
    expect(stepPxPerSec(10, -1)).toBeCloseTo(10 / ZOOM_STEP, 6);
  });

  it("round-trips a step in then out", () => {
    expect(stepPxPerSec(stepPxPerSec(10, 1), -1)).toBeCloseTo(10, 6);
  });
});

describe("secondsVisible", () => {
  it("reads the visible span off the scale", () => {
    expect(secondsVisible(1000, 50)).toBe(20);
  });

  it("is zero with no scale", () => {
    expect(secondsVisible(1000, 0)).toBe(0);
  });
});

describe("anchorScrollLeft", () => {
  it("pins the anchor time under its viewport offset", () => {
    // The anchor at 10s and 50 px/s sits at lane pixel 500; keeping it 200px into the viewport
    // scrolls to 300.
    expect(anchorScrollLeft(10, 50, 200, 4000, 1000)).toBe(300);
  });

  it("clamps to the scrollable range at both ends", () => {
    expect(anchorScrollLeft(0, 50, 200, 4000, 1000)).toBe(0);
    expect(anchorScrollLeft(80, 50, 200, 4000, 1000)).toBe(3000);
  });
});

describe("formatVisible", () => {
  it("shows whole seconds under a minute", () => {
    expect(formatVisible(12.4)).toBe("12s");
    expect(formatVisible(2)).toBe("2s");
  });

  it("shows m:ss at or past a minute", () => {
    expect(formatVisible(90)).toBe("1:30");
    expect(formatVisible(60)).toBe("1:00");
  });
});
