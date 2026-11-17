// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  alphaRange,
  buildMask,
  comparisonPlan,
  crop,
  diffImages,
  locateMarks,
  scaleRect,
  type DiffNumbers,
  type Rgba,
} from "./pixelDiff";

/** A diff the test expects to be valid, narrowed to its numbers. */
function numbers(stats: ReturnType<typeof diffImages>): DiffNumbers {
  if (!stats.valid) throw new Error(`invalid diff: ${stats.reason}`);
  return stats;
}

function solid(width: number, height: number, rgb: [number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) data.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
  return { width, height, data };
}

function setPixel(img: Rgba, x: number, y: number, rgb: [number, number, number]): void {
  img.data.set([rgb[0], rgb[1], rgb[2], 255], (y * img.width + x) * 4);
}

function paint(img: Rgba, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setPixel(img, i, j, rgb);
}

describe("diffImages", () => {
  it("reports no difference for identical images", () => {
    const a = solid(20, 20, [10, 20, 30]);
    expect(diffImages(a, solid(20, 20, [10, 20, 30]))).toEqual({ valid: true, max: 0, over: 0, p999: 0, compared: 400 });
  });

  it("sees one channel off by 3 inside the mask", () => {
    const a = solid(40, 40, [100, 100, 100]);
    const b = solid(40, 40, [100, 100, 100]);
    setPixel(b, 20, 20, [100, 103, 100]);
    const mask = buildMask(40, 40, [{ x: 0, y: 0, w: 40, h: 40 }], 4);
    const stats = numbers(diffImages(a, b, mask));
    expect(stats.max).toBe(3);
    expect(stats.over).toBe(1);
  });

  it("ignores the same difference on an edge band", () => {
    const a = solid(40, 40, [100, 100, 100]);
    const b = solid(40, 40, [100, 100, 100]);
    setPixel(b, 10, 20, [103, 100, 100]);
    const mask = buildMask(40, 40, [{ x: 10, y: 10, w: 20, h: 20 }], 4);
    const stats = numbers(diffImages(a, b, mask));
    expect(stats.max).toBe(0);
    expect(stats.over).toBe(0);
  });

  it("counts only differences above the threshold", () => {
    const a = solid(10, 10, [0, 0, 0]);
    const b = solid(10, 10, [0, 0, 0]);
    setPixel(b, 1, 1, [2, 0, 0]);
    setPixel(b, 2, 2, [0, 0, 5]);
    expect(numbers(diffImages(a, b))).toMatchObject({ max: 5, over: 1 });
  });

  it("takes the 99.9th percentile over the compared pixels", () => {
    const a = solid(100, 100, [0, 0, 0]);
    const b = solid(100, 100, [0, 0, 0]);
    paint(b, 0, 0, 1, 20, [9, 0, 0]);
    expect(numbers(diffImages(a, b))).toMatchObject({ max: 9, p999: 9, compared: 10000 });
    paint(b, 0, 0, 1, 20, [0, 0, 0]);
    paint(b, 0, 0, 1, 10, [9, 0, 0]);
    expect(numbers(diffImages(a, b))).toMatchObject({ max: 9, p999: 0 });
  });

  it("is invalid for images of different sizes", () => {
    expect(diffImages(solid(2, 2, [0, 0, 0]), solid(3, 2, [0, 0, 0])).valid).toBe(false);
  });

  it("is invalid when a buffer does not match its dimensions", () => {
    const short: Rgba = { width: 4, height: 4, data: new Uint8ClampedArray(10) };
    expect(diffImages(short, solid(4, 4, [0, 0, 0])).valid).toBe(false);
    expect(diffImages(solid(4, 4, [0, 0, 0]), short).valid).toBe(false);
  });

  it("is invalid when the mask does not match the image", () => {
    const a = solid(4, 4, [0, 0, 0]);
    expect(diffImages(a, a, new Uint8Array(3)).valid).toBe(false);
  });

  it("is invalid when nothing is compared", () => {
    const a = solid(4, 4, [0, 0, 0]);
    const result = diffImages(a, a, new Uint8Array(16));
    expect(result).toEqual({ valid: false, reason: "no pixels compared" });
  });

  it("is invalid when a difference is not a number", () => {
    const a = solid(2, 2, [0, 0, 0]);
    const data = new Float32Array(16);
    data[0] = NaN;
    const broken = { width: 2, height: 2, data } as unknown as Rgba;
    expect(diffImages(a, broken).valid).toBe(false);
  });

  it("does not compare alpha", () => {
    const a = solid(2, 2, [5, 5, 5]);
    const b = solid(2, 2, [5, 5, 5]);
    b.data[3] = 0;
    expect(numbers(diffImages(a, b)).max).toBe(0);
  });
});

describe("alphaRange", () => {
  it("reads the alpha an image holds", () => {
    const img = solid(2, 2, [0, 0, 0]);
    expect(alphaRange(img)).toEqual({ min: 255, max: 255 });
    img.data[7] = 10;
    expect(alphaRange(img)).toEqual({ min: 10, max: 255 });
    expect(alphaRange({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toBeNull();
  });
});

describe("buildMask", () => {
  it("clears the border band and keeps the interior", () => {
    const mask = buildMask(30, 30, [], 4);
    expect(mask[0]).toBe(0);
    expect(mask[3 * 30 + 15]).toBe(0);
    expect(mask[4 * 30 + 15]).toBe(1);
  });

  it("clears a small rectangle entirely", () => {
    const mask = buildMask(40, 40, [{ x: 20, y: 20, w: 6, h: 6 }], 4);
    expect(mask[23 * 40 + 23]).toBe(0);
  });
});

describe("comparisonPlan", () => {
  it("compares at device pixels when the capture matches the pixel ratio", () => {
    expect(comparisonPlan(1000, 800, 1.25)).toMatchObject({ kind: "device", scale: 1.25, margin: 6 });
  });

  it("compares a DIP-sized capture at capture scale with a wider edge band", () => {
    const device = comparisonPlan(1000, 800, 1.25);
    const dip = comparisonPlan(800, 800, 1.25);
    expect(dip).toMatchObject({ kind: "dip", scale: 1, margin: 8 });
    expect(dip.margin).toBeGreaterThan(device.margin);
  });

  it("treats a capture at ratio 1 as device pixels", () => {
    expect(comparisonPlan(800, 800, 1).kind).toBe("device");
  });

  it("marks any other scale invalid", () => {
    expect(comparisonPlan(900, 800, 1.25).kind).toBe("invalid");
    expect(comparisonPlan(1600, 800, 1.25).kind).toBe("invalid");
  });

  it("keeps a flat patch comparable after a DIP-sized downsample", () => {
    const patch = { x: 16, y: 16, w: 48, h: 48 };
    const plan = comparisonPlan(800, 800, 1.25);
    const rect = scaleRect(patch, plan.scale);
    const a = solid(100, 100, [40, 80, 120]);
    const b = solid(100, 100, [40, 80, 120]);
    const mask = buildMask(100, 100, [rect], plan.margin);
    expect(mask[40 * 100 + 40]).toBe(1);
    expect(numbers(diffImages(a, b, mask)).max).toBe(0);
  });
});

describe("crop", () => {
  it("copies the rectangle", () => {
    const img = solid(10, 10, [0, 0, 0]);
    setPixel(img, 3, 4, [9, 8, 7]);
    const out = crop(img, { x: 3, y: 4, w: 2, h: 2 });
    expect(out.width).toBe(2);
    expect(Array.from(out.data.slice(0, 4))).toEqual([9, 8, 7, 255]);
  });

  it("rejects a rectangle outside the image", () => {
    expect(() => crop(solid(4, 4, [0, 0, 0]), { x: 3, y: 3, w: 2, h: 2 })).toThrow(RangeError);
  });
});

describe("locateMarks", () => {
  const MAGENTA: [number, number, number] = [255, 0, 255];

  function withMarks(scale: number, ox: number, oy: number): Rgba {
    const img = solid(400, 300, [60, 60, 60]);
    const m = Math.round(8 * scale);
    const w = Math.round(200 * scale);
    const h = Math.round(120 * scale);
    for (const [x, y] of [[ox, oy], [ox + w - m, oy], [ox, oy + h - m], [ox + w - m, oy + h - m]]) {
      paint(img, x, y, m, m, MAGENTA);
    }
    return img;
  }

  it.each([1, 1.25, 1.5])("finds four marks at scale %s and offset", (scale) => {
    const found = locateMarks(withMarks(scale, 37, 21), 8);
    expect(found).not.toBeNull();
    expect(found?.scale).toBeCloseTo(Math.round(8 * scale) / 8);
    expect(found?.region.x).toBe(37);
    expect(found?.region.y).toBe(21);
    expect(found?.region.w).toBe(Math.round(200 * scale));
    expect(found?.marks).toHaveLength(4);
  });

  it("reads low when the mark edges are antialiased", () => {
    const img = withMarks(1.25, 37, 21);
    // Soften the left column and top row of every 10 px mark: strict color no longer matches them.
    const soft: [number, number, number] = [157, 30, 157];
    const edges = [[37, 21], [37 + 250 - 10, 21], [37, 21 + 150 - 10], [37 + 250 - 10, 21 + 150 - 10]];
    for (const [x, y] of edges) {
      paint(img, x, y, 1, 10, soft);
      paint(img, x, y, 10, 1, soft);
    }
    const found = locateMarks(img, 8);
    expect(found).not.toBeNull();
    expect(found?.scale).toBeCloseTo(9 / 8);
    expect(found?.scale).toBeLessThan(10 / 8);
    expect(found?.region.x).toBe(38);
    expect(found?.region.y).toBe(22);
  });

  it("returns null when a mark is missing or an extra blob is present", () => {
    const missing = withMarks(1, 10, 10);
    paint(missing, 10, 10, 8, 8, [60, 60, 60]);
    expect(locateMarks(missing, 8)).toBeNull();
    const extra = withMarks(1, 10, 10);
    paint(extra, 100, 200, 8, 8, MAGENTA);
    expect(locateMarks(extra, 8)).toBeNull();
  });

  it("returns null for four marks that are not on a rectangle", () => {
    const img = solid(300, 300, [60, 60, 60]);
    for (const [x, y] of [[10, 10], [150, 40], [20, 200], [200, 250]]) paint(img, x, y, 8, 8, MAGENTA);
    expect(locateMarks(img, 8)).toBeNull();
  });
});
