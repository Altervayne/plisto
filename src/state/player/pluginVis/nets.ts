/*
 * The hang and slow-frame watches for one stage frame, stepped from Plisto's own display loop. Both read
 * the transport's stats only, so they never tell a quiet frame from a hung one by guessing: time counts
 * only while Plisto's loop ran on schedule, the slot was visible and ticks were out. A gap in the loop (a
 * throttled, hidden or minimized window) or a change of visibility starts both watches over, so a
 * minimize-and-restore never reads as a hang. A frame's missing cost reading is never read as zero.
 */

// -- Local Imports --
import { HANG_LIMIT_MS, SLOW_FRAME_LIMIT_MS, SLOW_SPAN_MS } from "./netLimits";

// -- Type Imports --
import type { StagePhase } from "./stageMount";
import type { TransportStats } from "./transport";

/** A gap between two loop steps longer than this means the loop was throttled or stopped. */
export const LOOP_GAP_MS = 250;
/** How long ticks pause before the slow watch reads the frame's cost again. */
export const SLOW_PAUSE_MS = 1000;
/** How long the slow watch reads the frame's cost after the pause. */
export const SLOW_CONFIRM_MS = 1000;
// The fewest cost readings a median is taken over.
const MIN_SPAN_SAMPLES = 3;
const MIN_CONFIRM_SAMPLES = 3;

export interface NetInput {
  // The loop's clock, in ms.
  now: number;
  phase: StagePhase;
  stats: TransportStats | null;
  // Whether the slot itself is visible, whatever the slow watch withholds.
  slotVisible: boolean;
}

/** Whether a step follows the last one on schedule; the first step never does. */
function onSchedule(last: number | null, now: number): boolean {
  return last != null && now - last <= LOOP_GAP_MS;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Trips once a drawn frame leaves ticks unanswered for the hang limit of counted time. */
export function createHangWatch() {
  let last: number | null = null;
  let acked = -1;
  let since: number | null = null;
  let silent = 0;
  let tripped = false;

  return {
    step({ now, phase, stats }: NetInput): boolean {
      const counted = onSchedule(last, now);
      const gap = last == null ? 0 : now - last;
      last = now;
      if (tripped) return false;
      if (phase !== "ready" || !stats || !stats.visible) {
        silent = 0;
        since = null;
        return false;
      }
      const fresh = stats.acked !== acked || stats.visibleSince !== since;
      acked = stats.acked;
      since = stats.visibleSince;
      if (fresh || !counted) {
        silent = 0;
        return false;
      }
      if (stats.outstanding > 0) silent += gap;
      tripped = silent >= HANG_LIMIT_MS;
      return tripped;
    },
  };
}

interface Sample {
  at: number;
  ms: number;
}

export interface SlowStep {
  // Whether ticks are withheld for the pause.
  hold: boolean;
  slow: boolean;
}

/**
 * Trips once a drawn frame's own reported cost keeps a median over the slow-frame limit across the span,
 * then again after a pause in ticks: a frame that recovers once it gets a breather is kept.
 */
export function createSlowWatch() {
  let last: number | null = null;
  let acked = -1;
  let samples: Sample[] = [];
  let pauseUntil: number | null = null;
  let confirmFrom: number | null = null;
  let tripped = false;

  const restart = () => {
    samples = [];
    pauseUntil = null;
    confirmFrom = null;
  };

  return {
    step({ now, phase, stats, slotVisible }: NetInput): SlowStep {
      const counted = onSchedule(last, now);
      last = now;
      if (tripped) return { hold: false, slow: false };
      if (phase !== "ready" || !stats || !slotVisible || !counted) {
        restart();
        acked = stats?.acked ?? -1;
        return { hold: false, slow: false };
      }
      if (pauseUntil != null) {
        if (now < pauseUntil) return { hold: true, slow: false };
        pauseUntil = null;
        // The first answer after the pause may be for a tick sent before it.
        confirmFrom = now;
        acked = stats.acked + 1;
        samples = [];
        return { hold: false, slow: false };
      }
      if (stats.acked > acked) {
        if (stats.lastAckMs != null && acked >= 0) samples.push({ at: now, ms: stats.lastAckMs });
        acked = stats.acked;
      }
      if (confirmFrom != null) {
        if (now - confirmFrom < SLOW_CONFIRM_MS || samples.length < MIN_CONFIRM_SAMPLES) {
          return { hold: false, slow: false };
        }
        tripped = median(samples.map((s) => s.ms)) > SLOW_FRAME_LIMIT_MS;
        restart();
        return { hold: false, slow: tripped };
      }
      samples = samples.filter((s) => now - s.at <= SLOW_SPAN_MS);
      const spanned = samples.length >= MIN_SPAN_SAMPLES && now - samples[0].at >= SLOW_SPAN_MS - LOOP_GAP_MS;
      if (spanned && median(samples.map((s) => s.ms)) > SLOW_FRAME_LIMIT_MS) {
        pauseUntil = now + SLOW_PAUSE_MS;
        return { hold: true, slow: false };
      }
      return { hold: false, slow: false };
    },
  };
}
