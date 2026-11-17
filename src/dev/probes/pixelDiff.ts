/*
 * Pixel comparison for captures: crop, the edge mask that skips antialiased borders, the difference
 * statistics, and the finder for the registration marks of a pasted screenshot. Pure functions over RGBA
 * buffers, so the verdict rules are tested without a browser.
 */

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffNumbers {
  valid: true;
  /** Largest channel difference over the compared pixels. */
  max: number;
  /** Compared pixels whose largest channel difference exceeds the threshold. */
  over: number;
  /** The 99.9th percentile of the per-pixel largest channel difference. */
  p999: number;
  compared: number;
}

/** A comparison that cannot be trusted: no numbers, only the reason. */
export interface DiffInvalid {
  valid: false;
  reason: string;
}

export type DiffStats = DiffNumbers | DiffInvalid;

export type ScaleKind = "device" | "dip" | "invalid";

export interface ComparisonPlan {
  kind: ScaleKind;
  /** Capture pixels per CSS pixel. */
  scale: number;
  /** Capture pixels to keep clear of any patch or stage edge. */
  margin: number;
}

// Relative tolerance when matching a capture's scale to the device pixel ratio or to 1.
const SCALE_TOLERANCE = 0.01;
// Capture pixels kept clear of an edge, before the device-pixel allowance.
const EDGE_MARGIN_PX = 4;

/**
 * How a capture relates to the page: at device pixels, at CSS pixels (a DIP-sized capture, still valid
 * because patches are flat color, with an edge band widened by one more device-pixel allowance because
 * the downsample blurs edges further), or neither, which makes the run invalid.
 */
export function comparisonPlan(captureWidth: number, innerWidth: number, dpr: number): ComparisonPlan {
  const scale = innerWidth > 0 ? captureWidth / innerWidth : 0;
  const margin = EDGE_MARGIN_PX + Math.ceil(dpr);
  if (Math.abs(scale / dpr - 1) <= SCALE_TOLERANCE) return { kind: "device", scale, margin };
  if (Math.abs(scale - 1) <= SCALE_TOLERANCE) return { kind: "dip", scale, margin: margin + Math.ceil(dpr) };
  return { kind: "invalid", scale, margin };
}

/** A CSS-pixel rectangle in capture pixels, snapped to whole pixels. */
export function scaleRect(r: Rect, scale: number): Rect {
  const x = Math.round(r.x * scale);
  const y = Math.round(r.y * scale);
  return { x, y, w: Math.round((r.x + r.w) * scale) - x, h: Math.round((r.y + r.h) * scale) - y };
}

/** The pixels of `r` as their own image; the rectangle must lie inside the image. */
export function crop(img: Rgba, r: Rect): Rgba {
  if (r.x < 0 || r.y < 0 || r.w < 0 || r.h < 0 || r.x + r.w > img.width || r.y + r.h > img.height) {
    throw new RangeError("crop rectangle outside the image");
  }
  const data = new Uint8ClampedArray(r.w * r.h * 4);
  for (let row = 0; row < r.h; row++) {
    const from = ((r.y + row) * img.width + r.x) * 4;
    data.set(img.data.subarray(from, from + r.w * 4), row * r.w * 4);
  }
  return { width: r.w, height: r.h, data };
}

/**
 * A comparison mask, 1 for a pixel to compare. A band of `margin` pixels on both sides of every rectangle
 * edge and along the image border is cleared, so antialiasing and sampling at an edge never count.
 */
export function buildMask(width: number, height: number, rects: readonly Rect[], margin: number): Uint8Array {
  const mask = new Uint8Array(width * height).fill(1);
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      mask.fill(0, y * width + Math.max(0, x0), y * width + Math.min(width, x1));
    }
  };
  for (const r of rects) {
    const innerW = r.w - 2 * margin;
    const innerH = r.h - 2 * margin;
    if (innerW <= 0 || innerH <= 0) {
      clear(r.x - margin, r.y - margin, r.x + r.w + margin, r.y + r.h + margin);
      continue;
    }
    clear(r.x - margin, r.y - margin, r.x + r.w + margin, r.y + margin);
    clear(r.x - margin, r.y + r.h - margin, r.x + r.w + margin, r.y + r.h + margin);
    clear(r.x - margin, r.y + margin, r.x + margin, r.y + r.h - margin);
    clear(r.x + r.w - margin, r.y + margin, r.x + r.w + margin, r.y + r.h - margin);
  }
  clear(0, 0, width, margin);
  clear(0, height - margin, width, height);
  clear(0, 0, margin, height);
  clear(width - margin, 0, width, height);
  return mask;
}

/**
 * Channel-wise difference of two same-sized images over the masked pixels (all pixels without a mask).
 * Invalid when the buffers do not match their dimensions, nothing is compared, or a difference is not a
 * number. Alpha is not compared: the code assumes a window capture is opaque, which is not measured here.
 * `alphaRange` reads the alpha a capture actually holds, so a caller can report it.
 */
export function diffImages(a: Rgba, b: Rgba, mask?: Uint8Array, threshold = 2): DiffStats {
  if (a.width !== b.width || a.height !== b.height) return { valid: false, reason: "images differ in size" };
  const pixels = a.width * a.height;
  if (a.data.length !== pixels * 4 || b.data.length !== pixels * 4) {
    return { valid: false, reason: "pixel buffer does not match the image size" };
  }
  if (mask && mask.length !== pixels) return { valid: false, reason: "mask does not match the image size" };
  const histogram = new Uint32Array(256);
  let compared = 0;
  let over = 0;
  let max = 0;
  for (let p = 0; p < pixels; p++) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    );
    if (!Number.isInteger(d) || d > 255) return { valid: false, reason: "a pixel difference is not a byte value" };
    histogram[d]++;
    compared++;
    if (d > threshold) over++;
    if (d > max) max = d;
  }
  if (compared === 0) return { valid: false, reason: "no pixels compared" };
  let p999 = 0;
  const target = Math.ceil(compared * 0.999);
  for (let seen = 0, d = 0; d < 256; d++) {
    seen += histogram[d];
    if (seen >= target) {
      p999 = d;
      break;
    }
  }
  return { valid: true, max, over, p999, compared };
}

/** The smallest and largest alpha in an image; null for an empty one. */
export function alphaRange(img: Rgba): { min: number; max: number } | null {
  let min = 255;
  let max = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] < min) min = img.data[i];
    if (img.data[i] > max) max = img.data[i];
  }
  return img.data.length >= 4 ? { min, max } : null;
}

export interface MarksFound {
  /** One rectangle per mark, in image pixels. */
  marks: Rect[];
  /** The rectangle the four marks span, outer edges included. */
  region: Rect;
  /** Image pixels per CSS pixel, from the marks' size. */
  scale: number;
}

function isMagenta(data: Uint8ClampedArray | Uint8Array, i: number): boolean {
  return data[i] >= 230 && data[i + 1] <= 25 && data[i + 2] >= 230;
}

/** The bounding boxes of connected magenta blobs, in scan order. */
function magentaBlobs(img: Rgba): Rect[] {
  const { width, height, data } = img;
  const seen = new Uint8Array(width * height);
  const blobs: Rect[] = [];
  const stack: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || !isMagenta(data, start * 4)) continue;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop() as number;
      const x = p % width;
      const y = (p - x) / width;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (!seen[n] && isMagenta(data, n * 4)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    blobs.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return blobs;
}

/**
 * Finds the four registration marks of a pasted screenshot: square magenta blobs of `markCssPx` CSS pixels,
 * one per corner of a rectangle. Null when anything else is on the picture or the four are not found.
 * Blobs are matched by strict color, so antialiased edges shrink them: the scale reads low, good to about
 * 10 percent, and the region sits inside the true one by the width of the soft edge.
 */
export function locateMarks(img: Rgba, markCssPx: number): MarksFound | null {
  const marks = magentaBlobs(img).filter((b) => b.w >= 3 && b.h >= 3);
  if (marks.length !== 4) return null;
  const size = marks.reduce((s, m) => s + m.w, 0) / 4;
  if (marks.some((m) => Math.abs(m.w - m.h) > Math.max(1, 0.15 * m.w) || Math.abs(m.w - size) > 0.15 * size)) {
    return null;
  }
  const tol = Math.max(2, size / 2);
  const byY = [...marks].sort((p, q) => p.y - q.y);
  const [tl, tr] = byY.slice(0, 2).sort((p, q) => p.x - q.x);
  const [bl, br] = byY.slice(2).sort((p, q) => p.x - q.x);
  const aligned =
    Math.abs(tl.y - tr.y) <= tol &&
    Math.abs(bl.y - br.y) <= tol &&
    Math.abs(tl.x - bl.x) <= tol &&
    Math.abs(tr.x - br.x) <= tol &&
    tr.x > tl.x + size &&
    bl.y > tl.y + size;
  if (!aligned) return null;
  const x0 = Math.min(tl.x, bl.x);
  const y0 = Math.min(tl.y, tr.y);
  const x1 = Math.max(tr.x + tr.w, br.x + br.w);
  const y1 = Math.max(bl.y + bl.h, br.y + br.h);
  return { marks: [tl, tr, bl, br], region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, scale: size / markCssPx };
}
