/*
 * The drawing geometry of the EQ curve: a log-frequency x axis, a linear dB y axis, and the padding that
 * keeps handles and band labels inside the view box. Pure, so the pointer math and the paint share it.
 */

// -- Utils Imports --
import { responseDb } from "../../state/sound/curve";
import { GAIN_MAX_DB, GAIN_MIN_DB } from "../../state/sound/settings";

const F_MIN = 30;
const F_MAX = 20000;
const STEPS = 140;

export const PAD_X = 16;
export const PAD_TOP = 14;
export const PAD_BOTTOM = 14;
export const LABEL_BAND = 18;

/** The faint band labels under the handles, one per band. */
export const BAND_LABELS = ["60", "150", "400", "1k", "2.4k", "5k", "9k", "14k"] as const;

const SPAN_DB = GAIN_MAX_DB - GAIN_MIN_DB;

export interface Frame {
  width: number;
  plotHeight: number;
  /** The full view-box height: plot, padding and the label band. */
  height: number;
}

export function frameOf(width: number, plotHeight: number): Frame {
  return { width, plotHeight, height: PAD_TOP + plotHeight + PAD_BOTTOM + LABEL_BAND };
}

export function xOf(frame: Frame, freqHz: number): number {
  const t = Math.log(freqHz / F_MIN) / Math.log(F_MAX / F_MIN);
  return PAD_X + t * (frame.width - 2 * PAD_X);
}

export function yOf(frame: Frame, gainDb: number): number {
  return PAD_TOP + ((GAIN_MAX_DB - gainDb) / SPAN_DB) * frame.plotHeight;
}

/** The dB under a view-box y, unsnapped. */
export function gainAtY(frame: Frame, y: number): number {
  return GAIN_MAX_DB - ((y - PAD_TOP) / frame.plotHeight) * SPAN_DB;
}

/** The curve as an SVG line path, and the same path closed down to the 0 dB line for the fill. */
export function curvePaths(frame: Frame, gains: readonly number[]): { line: string; area: string } {
  const clampDb = (db: number) => Math.max(GAIN_MIN_DB - 1, Math.min(GAIN_MAX_DB + 1, db));
  let line = "";
  for (let s = 0; s <= STEPS; s++) {
    const f = F_MIN * Math.pow(F_MAX / F_MIN, s / STEPS);
    line += `${s === 0 ? "M" : "L"}${xOf(frame, f).toFixed(1)},${yOf(frame, clampDb(responseDb(gains, f))).toFixed(1)}`;
  }
  const y0 = yOf(frame, 0);
  const area = `${line}L${xOf(frame, F_MAX).toFixed(1)},${y0}L${xOf(frame, F_MIN).toFixed(1)},${y0}Z`;
  return { line, area };
}
