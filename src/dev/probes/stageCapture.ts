/*
 * Shared machinery of the probes that compare the two stages in a window capture: letting a change reach
 * the screen, taking and decoding a capture, measuring the two slots, diffing a region over a patch mask,
 * and asking a frame a question over its port.
 */

// -- Local Imports --
import { mountProbeFrame } from "./frames";
import { probeCapture } from "./ipc";
import { alphaRange, buildMask, comparisonPlan, crop, diffImages, scaleRect } from "./pixelDiff";

// -- Type Imports --
import type { MountedFrame } from "./frames";
import type { ComparisonPlan, DiffStats, Rect, Rgba } from "./pixelDiff";
import type { StageHandles } from "./types";

// Animation frames and a short pause that let a style or layer change reach the compositor before a capture.
const SETTLE_FRAMES = 3;
const SETTLE_MS = 80;
const REQUEST_TIMEOUT_MS = 4000;
// Distance from a whole device pixel beyond which an edge counts as off the grid.
const GRID_TOLERANCE = 0.02;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export function ensureRunning(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("aborted");
}

/** Waits long enough for the last change to be on screen. */
export async function settle(signal: AbortSignal): Promise<void> {
  for (let i = 0; i < SETTLE_FRAMES; i++) {
    ensureRunning(signal);
    await nextFrame();
  }
  await delay(SETTLE_MS);
  ensureRunning(signal);
}

export interface Capture {
  image: Rgba;
  plan: ComparisonPlan;
}

/** The alpha a capture holds, for the card: the comparison assumes an opaque capture and does not check it. */
export function alphaNote(c: Capture): string {
  const range = alphaRange(c.image);
  if (!range) return "capture alpha unknown";
  return range.min === range.max ? `capture alpha ${range.max}` : `capture alpha ${range.min} to ${range.max}`;
}

/** One window capture, decoded without color conversion, with how its scale relates to the page. */
export async function takeCapture(dpr: number, save = false): Promise<Capture> {
  const png = await probeCapture(save);
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }), { colorSpaceConversion: "none" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context to decode the capture");
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      image: { width: pixels.width, height: pixels.height, data: pixels.data },
      plan: comparisonPlan(pixels.width, window.innerWidth, dpr),
    };
  } finally {
    bitmap.close();
  }
}

export interface StageRects {
  /** Slot rectangles in viewport CSS pixels. */
  reference: Rect;
  subject: Rect;
  /** An edge of either slot is not on a whole device pixel. */
  offGrid: boolean;
  /** The measurement scrolled the page, so the layout may not have reached the screen yet. */
  scrolled: boolean;
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function inViewport(r: Rect): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= window.innerWidth && r.y + r.h <= window.innerHeight;
}

/** The two slot rectangles, scrolling the stages into view first when a capture would miss them. */
export function measureStages(stages: StageHandles, dpr: number): StageRects {
  const read = () => ({ reference: rectOf(stages.reference.slot), subject: rectOf(stages.subject.slot) });
  let rects = read();
  let scrolled = false;
  if (!inViewport(rects.reference) || !inViewport(rects.subject)) {
    stages.reference.panel.scrollIntoView({ block: "center", inline: "nearest" });
    scrolled = true;
    rects = read();
  }
  if (!inViewport(rects.reference) || !inViewport(rects.subject)) throw new Error("the stages do not fit in the window");
  if (Math.abs(rects.reference.w - rects.subject.w) > 0.01 || Math.abs(rects.reference.h - rects.subject.h) > 0.01) {
    throw new Error("the two slots differ in size");
  }
  const off = (v: number) => Math.abs(v * dpr - Math.round(v * dpr)) > GRID_TOLERANCE;
  const edges = [rects.reference, rects.subject].flatMap((r) => [r.x, r.y, r.x + r.w, r.y + r.h]);
  return { ...rects, offGrid: edges.some(off), scrolled };
}

function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
}

export type StableCapture = { ok: true; cap: Capture; rects: StageRects } | { ok: false; reason: string };

/**
 * A capture taken with the stages at rest: after any scroll the page settles first, and the slots are measured
 * before and after the capture. A capture during which they moved is retaken once, then reported unreadable.
 */
export function grabStable(
  stages: StageHandles,
  dpr: number,
  signal: AbortSignal,
  save: boolean,
): Promise<StableCapture> {
  return stableCapture(
    {
      measure: () => measureStages(stages, dpr),
      capture: () => takeCapture(dpr, save),
      settle: () => settle(signal),
    },
    signal,
  );
}

/** The page operations a stable capture needs, so the sequencing can be tested without a page. */
export interface StableIo {
  measure(): StageRects;
  capture(): Promise<Capture>;
  settle(): Promise<void>;
}

export async function stableCapture(io: StableIo, signal: AbortSignal): Promise<StableCapture> {
  for (let attempt = 0; attempt < 2; attempt++) {
    ensureRunning(signal);
    let before = io.measure();
    if (before.scrolled) {
      await io.settle();
      before = io.measure();
    }
    const cap = await io.capture();
    const after = io.measure();
    if (!before.scrolled && !after.scrolled && sameRect(before.reference, after.reference) && sameRect(before.subject, after.subject)) {
      return { ok: true, cap, rects: before };
    }
    await io.settle();
  }
  return { ok: false, reason: "the stages moved during the capture" };
}

/** Makes a frame fill its slot. */
export function fillFrame(el: HTMLIFrameElement): void {
  el.style.position = "absolute";
  el.style.left = "0";
  el.style.top = "0";
  el.style.border = "0";
  el.style.width = "100%";
  el.style.height = "100%";
}

/**
 * Mounts a probe-vis frame that fills `slot` and returns it once it has answered a paint request, which the
 * fixture sends after two animation frames, so an empty frame is not captured before it has rendered.
 */
export async function mountPainted(slot: HTMLElement, file: string, signal: AbortSignal): Promise<MountedFrame> {
  const frame = await mountProbeFrame({ host: "probe-vis", file, parent: slot, signal });
  fillFrame(frame.el);
  try {
    await request(frame.port, { type: "paint" }, "painted", signal);
  } catch (e) {
    frame.unmount();
    throw e;
  }
  return frame;
}

/**
 * Differences between two same-sized pixel rectangles over the area clear of every patch edge and of the
 * rectangle's own border. `patches` are CSS rectangles relative to the slot; `scale` is pixels per CSS pixel.
 */
export function diffPixelRects(
  a: Rgba,
  ra: Rect,
  b: Rgba,
  rb: Rect,
  patches: readonly Rect[],
  scale: number,
  margin: number,
  threshold = 2,
): DiffStats {
  if (ra.w !== rb.w || ra.h !== rb.h) return { valid: false, reason: "the two regions differ in size" };
  let left: Rgba;
  let right: Rgba;
  try {
    left = crop(a, ra);
    right = crop(b, rb);
  } catch (e) {
    return { valid: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const mask = buildMask(
    ra.w,
    ra.h,
    patches.map((p) => scaleRect(p, scale)),
    margin,
  );
  return diffImages(left, right, mask, threshold);
}

/**
 * Compares a slot of one capture with a slot of another (the same capture for two stages) at the capture's
 * own scale and edge margin. A capture whose scale is neither device nor DIP gives an invalid result.
 */
export function diffRegions(
  a: Capture,
  ra: Rect,
  b: Capture,
  rb: Rect,
  patches: readonly Rect[],
  threshold = 2,
): DiffStats {
  if (a.plan.kind === "invalid" || b.plan.kind === "invalid") {
    return { valid: false, reason: `capture scale ${a.plan.scale.toFixed(3)} is neither device nor DIP` };
  }
  const { scale, margin } = a.plan;
  const pa = scaleRect(ra, scale);
  const pb = { ...scaleRect(rb, scale), w: pa.w, h: pa.h };
  return diffPixelRects(a.image, pa, b.image, pb, patches, scale, margin, threshold);
}

let nextRequestId = 1;

/** Posts `message` to a frame and resolves with its answer of type `answer` carrying the same id. */
export function request(
  port: MessagePort,
  message: Record<string, unknown>,
  answer: string,
  signal: AbortSignal,
  transfer: Transferable[] = [],
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const id = nextRequestId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      port.onmessage = null;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      done();
      reject(new Error("aborted"));
    };
    timer = setTimeout(() => {
      done();
      reject(new Error(`no ${answer} answer after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);
    port.onmessage = (e: MessageEvent) => {
      const data = e.data as Record<string, unknown> | null;
      if (data && data.type === answer && data.id === id) {
        done();
        resolve(data);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      port.postMessage({ ...message, id }, transfer);
    } catch (e) {
      done();
      reject(e);
    }
  });
}
