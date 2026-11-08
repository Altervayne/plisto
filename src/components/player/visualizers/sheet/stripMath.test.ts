// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  FADE_LEFT,
  FADE_RIGHT,
  STRIP_PAD,
  TILE_STEP,
  chipAt,
  easeStep,
  fadeState,
  groupScroll,
  openScrollTarget,
  wheelStep,
} from "./stripMath";

const rest = { scroll: 400, max: 2000, easing: null };

describe("wheelStep", () => {
  it("moves one tile per line-mode notch", () => {
    expect(wheelStep({ deltaX: 0, deltaY: 3, deltaMode: 1 }, rest)).toEqual({ kind: "ease", to: 400 + TILE_STEP });
    expect(wheelStep({ deltaX: 0, deltaY: -3, deltaMode: 1 }, rest)).toEqual({ kind: "ease", to: 400 - TILE_STEP });
  });

  it("reads a large pixel delta as a notch", () => {
    expect(wheelStep({ deltaX: 0, deltaY: 100, deltaMode: 0 }, rest)).toEqual({ kind: "ease", to: 400 + TILE_STEP });
    expect(wheelStep({ deltaX: 0, deltaY: 50, deltaMode: 0 }, rest)).toEqual({ kind: "ease", to: 400 + TILE_STEP });
  });

  it("passes a trackpad's small pixel delta through 1:1", () => {
    expect(wheelStep({ deltaX: 0, deltaY: 12, deltaMode: 0 }, rest)).toEqual({ kind: "direct", to: 412 });
    expect(wheelStep({ deltaX: 2, deltaY: -49, deltaMode: 0 }, rest)).toEqual({ kind: "direct", to: 351 });
  });

  it("leaves a horizontal-dominant delta to the browser", () => {
    expect(wheelStep({ deltaX: 30, deltaY: 10, deltaMode: 0 }, rest)).toEqual({ kind: "native" });
    expect(wheelStep({ deltaX: 5, deltaY: 5, deltaMode: 0 }, rest)).toEqual({ kind: "native" });
  });

  it("adds a notch onto the target still easing, not the current offset", () => {
    const easing = { scroll: 450, max: 2000, easing: 578 };
    expect(wheelStep({ deltaX: 0, deltaY: 3, deltaMode: 1 }, easing)).toEqual({ kind: "ease", to: 578 + TILE_STEP });
  });

  it("clamps at both ends", () => {
    expect(wheelStep({ deltaX: 0, deltaY: -3, deltaMode: 1 }, { scroll: 60, max: 2000, easing: null })).toEqual({
      kind: "ease",
      to: 0,
    });
    expect(wheelStep({ deltaX: 0, deltaY: 3, deltaMode: 1 }, { scroll: 1950, max: 2000, easing: null })).toEqual({
      kind: "ease",
      to: 2000,
    });
    expect(wheelStep({ deltaX: 0, deltaY: 20, deltaMode: 0 }, { scroll: 1990, max: 2000, easing: null })).toEqual({
      kind: "direct",
      to: 2000,
    });
  });
});

describe("easeStep", () => {
  it("covers a fixed share of the remaining distance each frame", () => {
    expect(easeStep(0, 100)).toBeCloseTo(22);
    expect(easeStep(100, 0)).toBeCloseTo(78);
  });

  it("lands exactly on the target within a pixel and converges", () => {
    expect(easeStep(99.5, 100)).toBe(100);
    let at = 0;
    let frames = 0;
    while (at !== TILE_STEP && frames < 100) {
      at = easeStep(at, TILE_STEP);
      frames += 1;
    }
    expect(at).toBe(TILE_STEP);
    expect(frames).toBeLessThan(40);
  });
});

describe("fadeState", () => {
  it("shows only the right fade at the start and only the left at the end", () => {
    expect(fadeState(0, 1000)).toEqual({ left: 0, right: FADE_RIGHT });
    expect(fadeState(1000, 1000)).toEqual({ left: FADE_LEFT, right: 0 });
  });

  it("shows both in the middle and neither when nothing overflows", () => {
    expect(fadeState(500, 1000)).toEqual({ left: FADE_LEFT, right: FADE_RIGHT });
    expect(fadeState(0, 0)).toEqual({ left: 0, right: 0 });
  });

  it("treats a sub-pixel rest near an end as the end", () => {
    expect(fadeState(1.5, 1000)).toEqual({ left: 0, right: FADE_RIGHT });
    expect(fadeState(998.5, 1000)).toEqual({ left: FADE_LEFT, right: 0 });
  });
});

describe("chipAt", () => {
  const offsets = [4, 920, 1460, 2390, 3840];

  it("reads the group at the left edge, leading by a little", () => {
    expect(chipAt(0, offsets, 3200)).toBe(0);
    expect(chipAt(879, offsets, 3200)).toBe(0);
    expect(chipAt(880, offsets, 3200)).toBe(1);
    expect(chipAt(2400, offsets, 3200)).toBe(3);
  });

  it("reads the last group at the far end, which never reaches the left edge", () => {
    expect(chipAt(3200, offsets, 3200)).toBe(4);
    expect(chipAt(3196, offsets, 3200)).toBe(4);
  });

  it("falls back to the first group with no offsets", () => {
    expect(chipAt(100, [], 3200)).toBe(0);
  });
});

describe("groupScroll", () => {
  it("brings the heading to the left edge, clamped to the strip", () => {
    expect(groupScroll(920, 3000)).toBe(920 - STRIP_PAD);
    expect(groupScroll(STRIP_PAD, 3000)).toBe(0);
    expect(groupScroll(3500, 3000)).toBe(3000);
  });
});

describe("openScrollTarget", () => {
  it("opens with a group that fits its heading at the left edge", () => {
    expect(openScrollTarget({ tileLeft: 1096, groupLeft: 920, groupWidth: 524, viewport: 900, max: 3000 })).toBe(
      920 - STRIP_PAD,
    );
  });

  it("centres the checked tile when its group is wider than the strip", () => {
    const at = openScrollTarget({ tileLeft: 3100, groupLeft: 2390, groupWidth: 1416, viewport: 900, max: 3200 });
    expect(at).toBe(3100 + 85 - 450);
  });

  it("clamps the centred tile at the ends", () => {
    expect(openScrollTarget({ tileLeft: 4, groupLeft: 4, groupWidth: 1416, viewport: 900, max: 3200 })).toBe(0);
    expect(openScrollTarget({ tileLeft: 3840, groupLeft: 3840, groupWidth: 1416, viewport: 900, max: 3200 })).toBe(3200);
  });
});
