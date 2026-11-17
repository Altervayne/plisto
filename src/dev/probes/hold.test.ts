// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { MARK_CSS_PX, placeMarks, routePaste } from "./hold";
import { locateMarks, scaleRect } from "./pixelDiff";

// -- Type Imports --
import type { Rgba } from "./pixelDiff";

const DPR = 1.25;
// Coordinates are multiples of 0.8 CSS px, so every edge lands on a whole device pixel at 1.25.
const reference = { x: 32, y: 96, w: 478.4, h: 268.8 };
const subject = { x: 526.4, y: 96, w: 478.4, h: 268.8 };

describe("placeMarks", () => {
  const placed = placeMarks(reference, subject, DPR);

  it("puts the marks outside both slots at the corners of the region", () => {
    expect(placed.marks[0]).toEqual({ x: 16, y: 80, w: MARK_CSS_PX, h: MARK_CSS_PX });
    expect(placed.region.x).toBe(16);
    expect(placed.region.y).toBe(80);
    expect(placed.region.w).toBeCloseTo(1004.8);
    expect(placed.region.h).toBeCloseTo(268.8 + 32);
    expect(placed.marks[1].x + MARK_CSS_PX).toBeCloseTo(placed.region.x + placed.region.w);
    expect(placed.marks[3].y + MARK_CSS_PX).toBeCloseTo(placed.region.y + placed.region.h);
  });

  it("states the stages relative to the region, independent of where the page is scrolled", () => {
    expect(placed.layout.reference).toEqual({ x: 16, y: 16, w: 478.4, h: 268.8 });
    expect(placed.layout.subject.x).toBeCloseTo(510.4);
    const scrolled = placeMarks({ ...reference, y: reference.y - 40 }, { ...subject, y: subject.y - 40 }, DPR);
    expect(scrolled.layout).toEqual(placed.layout);
    expect(scrolled.region.y).toBe(placed.region.y - 40);
  });

  it("keeps every mark clear of both slots", () => {
    for (const m of placed.marks) {
      for (const s of [reference, subject]) {
        const apart = m.x + m.w <= s.x || m.x >= s.x + s.w || m.y + m.h <= s.y || m.y >= s.y + s.h;
        expect(apart).toBe(true);
      }
    }
  });

  it("is found again, with the stages in place, in a screenshot at device size", () => {
    const [ox, oy] = [50, 30];
    const img: Rgba = { width: 1400, height: 600, data: new Uint8ClampedArray(1400 * 600 * 4) };
    for (let p = 0; p < 1400 * 600; p++) img.data.set([60, 60, 60, 255], p * 4);
    for (const m of placed.marks) {
      const r = scaleRect(m, DPR);
      for (let y = r.y + oy; y < r.y + oy + r.h; y++) {
        for (let x = r.x + ox; x < r.x + ox + r.w; x++) img.data.set([255, 0, 255, 255], (y * 1400 + x) * 4);
      }
    }
    const found = locateMarks(img, MARK_CSS_PX);
    expect(found).not.toBeNull();
    expect(found?.scale).toBeCloseTo(DPR);
    expect(found?.region.w).toBeCloseTo(placed.layout.region.w * DPR, -0.5);
    const at = scaleRect(placed.layout.reference, DPR);
    const trueRef = scaleRect(reference, DPR);
    expect(Math.abs((found?.region.x ?? 0) + at.x - (trueRef.x + ox))).toBeLessThanOrEqual(1);
    expect(Math.abs((found?.region.y ?? 0) + at.y - (trueRef.y + oy))).toBeLessThanOrEqual(1);
  });
});

describe("routePaste", () => {
  it("takes the first image item", () => {
    expect(routePaste(true, ["text/plain", "image/png", "image/bmp"])).toEqual({ kind: "image", index: 1 });
  });

  it("ignores a paste with no case held, whatever it holds", () => {
    expect(routePaste(false, ["image/png"])).toEqual({ kind: "ignored", line: "paste ignored: no case is held" });
  });

  it("ignores a paste that is not an image", () => {
    expect(routePaste(true, ["text/plain"])).toEqual({
      kind: "ignored",
      line: "paste ignored: the clipboard holds no image",
    });
    expect(routePaste(true, []).kind).toBe("ignored");
  });
});
