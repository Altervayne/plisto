/*
 * The magnitude response of the 8-band EQ chain, for drawing. It mirrors the engine's filters: RBJ
 * cookbook biquads at the engine's constant table (peaks at Q 1.0, shelves at slope 1.0), evaluated at a
 * 48 kHz reference rate. The drawn curve is the sum of the per-band responses in dB.
 */

// -- Utils Imports --
import { BANDS, PEAK_Q, SHELF_SLOPE } from "./settings";

// -- Type Imports --
import type { Band } from "./settings";

/** The rate the drawn response is evaluated at. */
export const REFERENCE_RATE_HZ = 48000;

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/** RBJ coefficients for one band at `gainDb`, unnormalized. */
function coefficients(band: Band, gainDb: number, rate: number): Biquad {
  const a = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * band.freqHz) / rate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);

  if (band.kind === "peak") {
    const alpha = sin / (2 * PEAK_Q);
    return {
      b0: 1 + alpha * a,
      b1: -2 * cos,
      b2: 1 - alpha * a,
      a0: 1 + alpha / a,
      a1: -2 * cos,
      a2: 1 - alpha / a,
    };
  }

  const alpha = (sin / 2) * Math.sqrt((a + 1 / a) * (1 / SHELF_SLOPE - 1) + 2);
  const k = 2 * Math.sqrt(a) * alpha;
  if (band.kind === "lowShelf") {
    return {
      b0: a * (a + 1 - (a - 1) * cos + k),
      b1: 2 * a * (a - 1 - (a + 1) * cos),
      b2: a * (a + 1 - (a - 1) * cos - k),
      a0: a + 1 + (a - 1) * cos + k,
      a1: -2 * (a - 1 + (a + 1) * cos),
      a2: a + 1 + (a - 1) * cos - k,
    };
  }
  return {
    b0: a * (a + 1 + (a - 1) * cos + k),
    b1: -2 * a * (a - 1 + (a + 1) * cos),
    b2: a * (a + 1 + (a - 1) * cos - k),
    a0: a + 1 - (a - 1) * cos + k,
    a1: 2 * (a - 1 - (a + 1) * cos),
    a2: a + 1 - (a - 1) * cos - k,
  };
}

/** |b0 + b1 z^-1 + b2 z^-2|^2 on the unit circle at angular frequency `w`. */
function powerAt(b0: number, b1: number, b2: number, w: number): number {
  const re = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
  const im = b1 * Math.sin(w) + b2 * Math.sin(2 * w);
  return re * re + im * im;
}

/** One band's response in dB at `freqHz`. */
export function bandResponseDb(
  band: Band,
  gainDb: number,
  freqHz: number,
  rate: number = REFERENCE_RATE_HZ,
): number {
  if (gainDb === 0) return 0;
  const c = coefficients(band, gainDb, rate);
  const w = (2 * Math.PI * freqHz) / rate;
  return 10 * Math.log10(powerAt(c.b0, c.b1, c.b2, w) / powerAt(c.a0, c.a1, c.a2, w));
}

/** The whole chain's response in dB at `freqHz`, for the eight band gains. */
export function responseDb(gains: readonly number[], freqHz: number): number {
  let total = 0;
  for (let i = 0; i < BANDS.length; i++) total += bandResponseDb(BANDS[i], gains[i] ?? 0, freqHz);
  return total;
}
