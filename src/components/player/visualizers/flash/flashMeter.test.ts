// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createFlashMeter, redness, type FlashMeterOptions } from "./flashMeter";

const W = 40;
const H = 30;
const OPTS: FlashMeterOptions = { winW: 20, winH: 15, step: 0.1, darkerBelow: 0.8 };
const LOW = 0.2;
const HIGH = 0.5;

/** Feeds a meter `seconds` of 60 fps frames; `value(frame, x, y)` is each pixel's luminance. */
function run(seconds: number, value: (frame: number, x: number, y: number) => number, opts = OPTS, w = W, h = H) {
  const meter = createFlashMeter(w, h, opts);
  const values = new Float32Array(w * h);
  for (let f = 0; f < seconds * 60; f++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = value(f, x, y);
    meter.frame(values);
  }
  return meter.result();
}

const wave = (hz: number, low = LOW, high = HIGH) => (f: number) => (Math.floor((f * 2 * hz) / 60) % 2 === 0 ? low : high);

describe("createFlashMeter", () => {
  it("counts a full-window square wave at 4 Hz as more than three flashes a second", () => {
    expect(run(3, wave(4)).flashesPerSec).toBeGreaterThan(3);
  });

  it("passes the same wave at 2 Hz", () => {
    const { flashesPerSec } = run(3, wave(2));
    expect(flashesPerSec).toBeGreaterThan(0);
    expect(flashesPerSec).toBeLessThanOrEqual(3);
  });

  it("counts a rise spread over six frames and a fall as one flash", () => {
    const ramp = (f: number) => {
      if (f < 20) return 0.3;
      if (f < 26) return 0.3 + (0.2 * (f - 19)) / 6;
      if (f < 46) return 0.5;
      return 0.3;
    };
    expect(run(2, ramp).flashesPerSec).toBe(1);
  });

  it("gives no flash to an up-only ramp", () => {
    expect(run(3, (f) => 0.2 + (0.6 * f) / 180).flashesPerSec).toBe(0);
  });

  it("gives no flash when the darker end is not under 0.8", () => {
    expect(run(3, wave(4, 0.85, 1)).flashesPerSec).toBe(0);
  });

  it("counts a fall from 1.0 to 0.2 by the low it reaches, not by where the transition completes", () => {
    expect(run(3, wave(4, 0.2, 1)).flashesPerSec).toBeGreaterThan(3);
  });

  it("ignores an amplitude under the step", () => {
    expect(run(3, wave(4, 0.2, 0.29)).flashesPerSec).toBe(0);
  });

  it("does not pair changes more than a second apart", () => {
    expect(run(4, wave(0.4)).flashesPerSec).toBeLessThanOrEqual(1);
  });

  it("counts an area transition split across two frames once, wherever a fixed bin would end", () => {
    // Two groups of 15% each of any window change one frame apart: 30% together, never 25% in one frame.
    const group = (x: number, y: number) => (x + 5 * y) % 20;
    const split = (f: number, x: number, y: number) => {
      const g = group(x, y);
      const at = g < 3 ? 59 : g < 6 ? 60 : -1;
      const back = g < 3 ? 80 : g < 6 ? 81 : -1;
      return at >= 0 && f >= at && f < back ? HIGH : LOW;
    };
    expect(run(2, split).flashesPerSec).toBe(1);
  });

  it("fails a full-window square wave with a period of four frames", () => {
    const fast = (f: number) => (Math.floor(f / 2) % 2 === 0 ? 0.2 : 1);
    const { flashesPerSec } = run(3, fast);
    expect(flashesPerSec).toBeGreaterThan(10);
  });

  it("fails a full-window square wave with a period of two frames", () => {
    const fastest = (f: number) => (f % 2 === 0 ? 0.2 : 1);
    expect(run(3, fastest).flashesPerSec).toBeGreaterThan(20);
  });

  it("counts at most one flash when half the window goes up and half goes down once", () => {
    const once = (f: number, x: number) => {
      const left = x < 20;
      if (f < 30) return left ? LOW : HIGH;
      return left ? HIGH : LOW;
    };
    const { flashesPerSec } = run(2, once);
    expect(flashesPerSec).toBeLessThanOrEqual(1);
  });

  it("passes pixels that each flash once a second with phases spread evenly over the second", () => {
    const spread = (f: number, x: number, y: number) => ((f + x + y * W) % 60 < 10 ? HIGH : LOW);
    expect(run(3, spread).flashesPerSec).toBe(0);
  });

  it("fails pixels that each flash six times a second in phases spread evenly, since out-of-phase flashing counts once a quarter of the window moves within the span", () => {
    const spread = (f: number, x: number, y: number) => ((f + x + y * W) % 10 < 5 ? HIGH : LOW);
    expect(run(3, spread).flashesPerSec).toBeGreaterThan(3);
  });

  it("gives no flash to a thin line scrolling so that every pixel alternates but under a quarter moves at once", () => {
    const line = (f: number, x: number) => ((x + f) % 24 === 0 ? HIGH : LOW);
    const result = run(3, line);
    expect(result.flashesPerSec).toBe(0);
    expect(result.flickerShare).toBeGreaterThan(0.25);
  });

  it("passes a square wave over a fifth of the window at 10 Hz on area", () => {
    const block = (f: number, x: number, y: number) => (x >= 5 && x < 12 && y >= 3 && y < 10 ? wave(10)(f) : LOW);
    expect(run(3, block).flashesPerSec).toBe(0);
  });

  it("reports a stage smaller than the window as not measured", () => {
    const result = run(1, wave(4), OPTS, 10, 10);
    expect(result.measured).toBe(false);
    expect(run(1, wave(4)).measured).toBe(true);
  });
});

describe("the red measure", () => {
  const red = (r: number, g: number, b: number) => redness(Uint8Array.of(r, g, b, 255), 0);
  const redOpts: FlashMeterOptions = { winW: 20, winH: 15, step: 20, darkerBelow: null };

  it("fails a saturated-red wave at 4 Hz", () => {
    const strong = red(255, 10, 10);
    const weak = red(80, 10, 10);
    expect(run(3, wave(4, weak, strong), redOpts).flashesPerSec).toBeGreaterThan(3);
  });

  it("reads zero on a grey wave", () => {
    expect(red(200, 200, 200)).toBe(0);
    expect(run(3, wave(4, red(60, 60, 60), red(200, 200, 200)), redOpts).flashesPerSec).toBe(0);
  });
});
