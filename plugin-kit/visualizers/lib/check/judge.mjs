/*
 * Judges one scripted run by Plisto's limits. A run is the readings the host page collected after the kind
 * said it was ready: the flash readings the runtime posted, and one entry per consumed tick with its time
 * since ready and the step cost the runtime acked. All times are in ms. Pure, so the limits can be tested
 * without a browser.
 */

// -- Local Imports --
import {
  FLASHES_PER_SEC_LIMIT,
  HANG_LIMIT_MS,
  RED_FLASHES_LIMIT,
  SLOW_FRAME_LIMIT_MS,
  SLOW_SPAN_MS,
} from "../limits.js";

/** The median of a list of numbers, or null for an empty list. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The worst flash reading: whether it breaks the rule, and the figures. The runtime reports only when the
 * meter trips, so an empty list means "never over the limit" and its figures are null, never 0.
 */
export function judgeFlash(readings, metered) {
  if (!metered) {
    return { judged: false, flashing: false, red: false, flashesPerSec: null, redFlashesPerSec: null };
  }
  if (readings.length === 0) {
    return { judged: true, flashing: false, red: false, flashesPerSec: null, redFlashesPerSec: null };
  }
  const worst = (key) => readings.reduce((m, r) => Math.max(m, r[key]), 0);
  const flashesPerSec = worst("flashesPerSec");
  const redFlashesPerSec = worst("redFlashesPerSec");
  return {
    judged: true,
    flashing: flashesPerSec > FLASHES_PER_SEC_LIMIT,
    red: redFlashesPerSec > RED_FLASHES_LIMIT,
    flashesPerSec,
    redFlashesPerSec,
  };
}

/**
 * Whether the kind stopped answering: no consumed tick within the hang limit after ready, or a gap that long
 * between two, or since the last one to the end of the run.
 */
export function judgeHang(frames, runMs) {
  const marks = [0, ...frames.map((f) => f.at), runMs];
  let gap = 0;
  for (let i = 1; i < marks.length; i++) gap = Math.max(gap, marks[i] - marks[i - 1]);
  return { hung: gap > HANG_LIMIT_MS, longestGapMs: gap };
}

/**
 * Whether the median step cost stays over the limit for the whole span. A run shorter than the span is
 * judged as one window.
 */
export function judgeSlow(frames) {
  const costs = frames.filter((f) => f.ms !== null);
  const medianMs = median(costs.map((f) => f.ms));
  const worstMs = costs.reduce((m, f) => Math.max(m, f.ms), 0);
  if (costs.length === 0) return { slow: false, medianMs, worstMs: null };
  const first = costs[0].at;
  const spanned = costs[costs.length - 1].at - first >= SLOW_SPAN_MS;
  let slow = false;
  if (!spanned) slow = medianMs > SLOW_FRAME_LIMIT_MS;
  else {
    for (const end of costs) {
      if (end.at - first < SLOW_SPAN_MS) continue;
      const window = costs.filter((f) => f.at > end.at - SLOW_SPAN_MS && f.at <= end.at);
      if (median(window.map((f) => f.ms)) > SLOW_FRAME_LIMIT_MS) {
        slow = true;
        break;
      }
    }
  }
  return { slow, medianMs, worstMs };
}

/** Every verdict for one kind's run. `run` is `{ readyMs, metered, flash, frames, runMs }`. */
export function judgeRun(run) {
  const flash = judgeFlash(run.flash, run.metered);
  return {
    readyMs: run.readyMs,
    frames: run.frames.length,
    ...flash,
    ...judgeHang(run.frames, run.runMs),
    ...judgeSlow(run.frames),
  };
}
