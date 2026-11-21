/*
 * The flash meter: WCAG 2.3.1 luminance and saturated-red measures, a per-pixel transition tracker, and the
 * window counts over it. It is pure: it takes per-pixel values frame by frame and holds no canvas.
 */

// sRGB byte to linear light.
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** WCAG relative luminance of the pixel at byte offset `i`. */
export function relativeLuminance(bytes: Uint8Array, i: number): number {
  return 0.2126 * LINEAR[bytes[i]] + 0.7152 * LINEAR[bytes[i + 1]] + 0.0722 * LINEAR[bytes[i + 2]];
}

/** WCAG's saturated-red measure: (R - G - B) x 320 on linear values, floored at 0, for a state that is mostly red. */
export function redness(bytes: Uint8Array, i: number): number {
  const r = LINEAR[bytes[i]];
  const g = LINEAR[bytes[i + 1]];
  const b = LINEAR[bytes[i + 2]];
  const total = r + g + b;
  return total > 0 && r / total >= 0.8 ? Math.max(0, (r - g - b) * 320) : 0;
}

function popcount(v: number): number {
  let n = v - ((v >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// A flash pairs two opposing changes within a second of frames, held as a 60-bit history at most.
const SECOND_FRAMES = 60;
// Pixels completing a same-direction transition within this many frames (50 ms at 60 fps) count as concurrent.
export const FLASH_SPAN_FRAMES = 3;
const SPAN_SECONDS = FLASH_SPAN_FRAMES / SECOND_FRAMES;
// Windows are laid on a grid with this stride, in pixels.
const WINDOW_STRIDE = 4;
// The share of a window that must transition within the span to make an area transition.
const AREA_SHARE = 0.25;

/** Follows every pixel across frames and reports the transitions it completes. */
interface FlashTracker {
  /** Per pixel, the direction (1 up, -1 down) of a transition counted on the last frame, else 0. */
  readonly moves: Int8Array;
  /** Feeds one frame of per-pixel values. */
  step: (values: Float32Array) => void;
  /** Marks the pixels that completed a flash of their own in the last second. Returns whether any is marked. */
  flickered: (out: Uint8Array) => boolean;
}

/**
 * A pixel's transition completes when it has moved `step` from its last extreme. An up transition counts
 * when the trough it rose from is under `darkerBelow`; a down one counts once the low it reaches is, so
 * both use the darker end of the change. A flash is a counted transition followed by an opposing one,
 * non-overlapping. A null `darkerBelow` counts every transition.
 */
function createFlashTracker(n: number, step: number, darkerBelow: number | null, second: number): FlashTracker {
  const last = new Float32Array(n);
  const cur = new Float32Array(n);
  const dir = new Int8Array(n);
  const prev = new Int8Array(n);
  const moves = new Int8Array(n);
  // A completed down transition still above the ceiling, and whether it would complete a flash.
  const pendingDown = new Uint8Array(n);
  const pendingPair = new Uint8Array(n);
  const flashAge = new Uint8Array(n).fill(255);
  let ready = false;
  const dark = (x: number) => darkerBelow === null || x < darkerBelow;
  return {
    moves,
    step(values) {
      if (!ready) {
        last.set(values);
        cur.set(values);
        ready = true;
      }
      for (let i = 0; i < n; i++) {
        const v = values[i];
        let move = 0;
        let trough = 0;
        if (dir[i] === 0) {
          if (v - last[i] >= step) {
            move = 1;
            trough = last[i];
          } else if (last[i] - v >= step) move = -1;
          if (move !== 0) {
            dir[i] = move;
            cur[i] = v;
          }
        } else if (dir[i] === 1) {
          if (v > cur[i]) cur[i] = v;
          else if (cur[i] - v >= step) {
            move = -1;
            last[i] = cur[i];
            cur[i] = v;
            dir[i] = -1;
          }
        } else if (v < cur[i]) cur[i] = v;
        else if (v - cur[i] >= step) {
          move = 1;
          trough = cur[i];
          last[i] = cur[i];
          cur[i] = v;
          dir[i] = 1;
        }

        let counted = 0;
        let flash = false;
        if (move === 0) {
          if (pendingDown[i] === 1 && dir[i] === -1 && dark(cur[i])) {
            counted = -1;
            flash = pendingPair[i] === 1;
            pendingDown[i] = 0;
            pendingPair[i] = 0;
          }
        } else if (move === 1) {
          pendingDown[i] = 0;
          pendingPair[i] = 0;
          const ok = dark(trough);
          if (ok) counted = 1;
          if (prev[i] === -1 && ok) {
            flash = true;
            prev[i] = 0;
          } else prev[i] = ok ? 1 : 0;
        } else {
          const pair = prev[i] === 1;
          pendingDown[i] = 0;
          pendingPair[i] = 0;
          if (dark(v)) {
            counted = -1;
            flash = pair;
          } else {
            pendingDown[i] = 1;
            pendingPair[i] = pair ? 1 : 0;
          }
          prev[i] = pair ? 0 : -1;
        }
        moves[i] = counted;
        flashAge[i] = flash ? 0 : Math.min(255, flashAge[i] + 1);
      }
    },
    flickered(out) {
      let any = false;
      for (let i = 0; i < n; i++) {
        const hit = flashAge[i] < second ? 1 : 0;
        out[i] = hit;
        if (hit) any = true;
      }
      return any;
    },
  };
}

/** The marked pixels inside each `winW` x `winH` window of a w x h mask, row by row, over a summed-area table. */
export function windowCounts(mask: Uint8Array, w: number, h: number, winW: number, winH: number): Int32Array {
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Int32Array(windowTotal(w, h, winW, winH));
  let k = 0;
  for (let y = 0; y + winH <= h; y += WINDOW_STRIDE) {
    for (let x = 0; x + winW <= w; x += WINDOW_STRIDE) {
      const a = sat[(y + winH) * (w + 1) + x + winW] - sat[y * (w + 1) + x + winW];
      out[k++] = a - sat[(y + winH) * (w + 1) + x] + sat[y * (w + 1) + x];
    }
  }
  return out;
}

function windowTotal(w: number, h: number, winW: number, winH: number): number {
  if (w < winW || h < winH) return 0;
  return (Math.floor((w - winW) / WINDOW_STRIDE) + 1) * (Math.floor((h - winH) / WINDOW_STRIDE) + 1);
}

/** The most marked pixels inside any window of a w x h mask. */
export function worstWindow(mask: Uint8Array, w: number, h: number, winW: number, winH: number): number {
  return windowCounts(mask, w, h, winW, winH).reduce((a, b) => Math.max(a, b), 0);
}

export interface FlashMeterOptions {
  winW: number;
  winH: number;
  step: number;
  darkerBelow: number | null;
  /** Frames fed per second; 60 when absent. A second and the concurrency span scale with it. */
  rate?: number;
}

export interface FlashMeter {
  frame: (values: Float32Array) => void;
  result: () => { measured: boolean; flashesPerSec: number; flickerShare: number };
}

/**
 * Measures WCAG 2.3.1 flashes over a run of frames. Per window and direction, the transitions completed
 * in the last span frames (FLASH_SPAN_FRAMES at the default rate) are summed, skipping those already used
 * by an earlier area transition; at a quarter of the window that is an area transition. A window flash
 * is an area transition followed by the opposing one within a second, pairs not overlapping; when both
 * directions fire on one frame, the one that completes a pending pair goes first. `flashesPerSec` is the
 * most window flashes in any second over all windows. `flickerShare` is the most pixels of any window that flashed on their own within
 * a second, whenever they did: information only. `measured` is false when the stage is smaller than the
 * window.
 */
export function createFlashMeter(w: number, h: number, opts: FlashMeterOptions): FlashMeter {
  const { winW, winH } = opts;
  const n = w * h;
  const windows = windowTotal(w, h, winW, winH);
  const second = Math.min(SECOND_FRAMES, Math.max(1, Math.round(opts.rate ?? SECOND_FRAMES)));
  const span = Math.max(1, Math.round(second * SPAN_SECONDS));
  const loMask = second >= 32 ? 0xffffffff : 2 ** second - 1;
  const hiMask = second > 32 ? 2 ** (second - 32) - 1 : 0;
  const tracker = createFlashTracker(n, opts.step, opts.darkerBelow, second);
  const up = new Uint8Array(n);
  const down = new Uint8Array(n);
  const flicker = new Uint8Array(n);
  // The window counts of the last span frames, by frame index modulo the span.
  const upRing = Array.from({ length: span }, () => new Int32Array(windows));
  const downRing = Array.from({ length: span }, () => new Int32Array(windows));
  const lastUp = new Int32Array(windows).fill(-1e9);
  const lastDown = new Int32Array(windows).fill(-1e9);
  const pending = new Int8Array(windows);
  const pendingAt = new Int32Array(windows);
  const lo = new Uint32Array(windows);
  const hi = new Uint32Array(windows);
  const needed = Math.ceil(AREA_SHARE * winW * winH);
  let frames = 0;
  let worstRate = 0;
  let worstFlicker = 0;

  /** The unused transitions of one direction in the span, for window k. */
  const spanCount = (ring: Int32Array[], last: Int32Array, k: number): number => {
    let sum = 0;
    for (let j = Math.max(0, frames - span + 1, last[k] + 1); j <= frames; j++) sum += ring[j % span][k];
    return sum;
  };

  /** Records an area transition in window k; returns 1 when it completes a flash. */
  const fire = (k: number, dir: number): number => {
    if (pending[k] === -dir && frames - pendingAt[k] <= second) {
      pending[k] = 0;
      return 1;
    }
    pending[k] = dir;
    pendingAt[k] = frames;
    return 0;
  };

  return {
    frame(values) {
      tracker.step(values);
      let anyUp = false;
      let anyDown = false;
      for (let i = 0; i < n; i++) {
        const m = tracker.moves[i];
        up[i] = m > 0 ? 1 : 0;
        down[i] = m < 0 ? 1 : 0;
        if (m > 0) anyUp = true;
        else if (m < 0) anyDown = true;
      }
      const slot = frames % span;
      upRing[slot] = anyUp ? windowCounts(up, w, h, winW, winH) : new Int32Array(windows);
      downRing[slot] = anyDown ? windowCounts(down, w, h, winW, winH) : new Int32Array(windows);
      for (let k = 0; k < windows; k++) {
        let flash = 0;
        const fireUp = spanCount(upRing, lastUp, k) >= needed;
        const fireDown = spanCount(downRing, lastDown, k) >= needed;
        if (fireUp) lastUp[k] = frames;
        if (fireDown) lastDown[k] = frames;
        const downFirst = pending[k] === 1;
        if (downFirst && fireDown) flash |= fire(k, -1);
        if (fireUp) flash |= fire(k, 1);
        if (!downFirst && fireDown) flash |= fire(k, -1);
        hi[k] = ((hi[k] << 1) | (lo[k] >>> 31)) & hiMask;
        lo[k] = ((lo[k] << 1) | flash) >>> 0;
        worstRate = Math.max(worstRate, popcount((lo[k] & loMask) >>> 0) + popcount(hi[k]));
      }
      if (windows > 0 && tracker.flickered(flicker)) {
        worstFlicker = Math.max(worstFlicker, worstWindow(flicker, w, h, winW, winH) / (winW * winH));
      }
      frames++;
    },
    result: () => ({ measured: windows > 0, flashesPerSec: worstRate, flickerShare: worstFlicker }),
  };
}
