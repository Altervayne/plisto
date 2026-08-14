// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { scrollDeltaForDrag, thumbGeometry } from "./scrollGeometry";

describe("thumbGeometry", () => {
  it("hides the thumb when content fits the viewport", () => {
    expect(thumbGeometry({ viewport: 400, content: 400, scroll: 0, track: 400, minThumb: 24 })).toBeNull();
    expect(thumbGeometry({ viewport: 400, content: 300, scroll: 0, track: 400, minThumb: 24 })).toBeNull();
  });

  it("sizes the thumb to the visible fraction", () => {
    // Twice the content: the thumb covers half the track.
    const geo = thumbGeometry({ viewport: 400, content: 800, scroll: 0, track: 400, minThumb: 24 });
    expect(geo?.size).toBe(200);
    expect(geo?.offset).toBe(0);
  });

  it("pins the thumb flush at the track end when scrolled to the max", () => {
    const geo = thumbGeometry({ viewport: 400, content: 800, scroll: 400, track: 400, minThumb: 24 });
    expect(geo?.offset).toBe(200);
    // Offset plus size reaches the far edge of the track.
    expect((geo?.offset ?? 0) + (geo?.size ?? 0)).toBe(400);
  });

  it("floors the thumb at minThumb for a very long content", () => {
    // Raw size would be 4px; the clamp holds it at the grabbable minimum.
    const geo = thumbGeometry({ viewport: 40, content: 4000, scroll: 0, track: 400, minThumb: 24 });
    expect(geo?.size).toBe(24);
  });

  it("keeps a clamped thumb within the track across the full scroll range", () => {
    const metrics = { viewport: 40, content: 4000, scroll: 3960, track: 400, minThumb: 24 };
    const geo = thumbGeometry(metrics);
    expect(geo?.offset).toBe(400 - 24);
    expect((geo?.offset ?? 0) + (geo?.size ?? 0)).toBe(400);
  });

  it("guards the divide when the content equals the viewport height plus nothing to travel", () => {
    // track smaller than minThumb clamps size to the track, leaving zero travel.
    const geo = thumbGeometry({ viewport: 10, content: 20, scroll: 5, track: 16, minThumb: 24 });
    expect(geo?.size).toBe(16);
    expect(geo?.offset).toBe(0);
  });

  it("returns null when the track has not been measured", () => {
    expect(thumbGeometry({ viewport: 400, content: 800, scroll: 0, track: 0, minThumb: 24 })).toBeNull();
  });
});

describe("scrollDeltaForDrag", () => {
  it("maps a full-track drag onto the whole content range", () => {
    // travel = track - size = 400 - 200 = 200; a 200px drag covers content - viewport = 400.
    const metrics = { viewport: 400, content: 800, scroll: 0, track: 400, minThumb: 24 };
    expect(scrollDeltaForDrag(200, metrics)).toBe(400);
    expect(scrollDeltaForDrag(100, metrics)).toBe(200);
  });

  it("is zero when there is nothing to scroll", () => {
    expect(scrollDeltaForDrag(50, { viewport: 400, content: 400, scroll: 0, track: 400, minThumb: 24 })).toBe(0);
  });

  it("is zero when a clamped thumb leaves no travel", () => {
    expect(scrollDeltaForDrag(50, { viewport: 10, content: 20, scroll: 0, track: 16, minThumb: 24 })).toBe(0);
  });
});
