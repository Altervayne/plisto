/*
 * The beat clock: a tempo estimate and a phase built from the beat events alone, since the signal carries
 * no tempo. The period eases toward each gap between beats, folded to the nearest whole number of periods
 * so a missed beat does not halve the tempo. The phase is pulled toward each beat rather than snapped, and
 * `lock` says whether the clock has beats worth trusting. Pure and dt-driven: the caller owns the state.
 */

// -- Local Imports --
import { easeEnvelope } from "../../../../state/player/visualSignal";

// The period before any beat has been heard, in seconds.
const START_PERIOD = 0.5;
// A gap longer than this is a pause, not a beat interval.
const MAX_GAP = 2.5;
// The accepted range for a folded beat interval, in seconds.
const MIN_PERIOD = 0.3;
const MAX_PERIOD = 1.2;
// The share of the gap error each accepted beat folds into the period.
const PERIOD_EASE = 0.3;
// The time constant of the phase pull toward a beat, in seconds.
const PULL_TAU = 0.5;
// Beats older than this no longer hold the lock, in seconds.
const BEAT_FRESH = 3;
// The time constant of the lock easing either way, in seconds.
const LOCK_TAU = 1.5;

export interface BeatClock {
  // Seconds since the clock started.
  clock: number;
  // The clock time of the last beat, or -1 before the first.
  lastBeat: number;
  // The estimated beat period, in seconds.
  period: number;
  // The phase in beats; its fraction is the position within the beat.
  beatPos: number;
  // The phase correction still to be applied, in beats.
  pull: number;
  // 0..1: how far the clock is trusted.
  lock: number;
}

/** A fresh clock at the starting period, unlocked. */
export function createBeatClock(): BeatClock {
  return { clock: 0, lastBeat: -1, period: START_PERIOD, beatPos: 0, pull: 0, lock: 0 };
}

/**
 * Advances the clock by `dt` seconds. `beat` is the signal's beat strength on this frame (0 for none) and
 * `drive` its reactivity gain; at 0 the clock never locks.
 */
export function stepBeatClock(st: BeatClock, dt: number, beat: number, drive: number): void {
  st.clock += dt;
  if (beat > 0) {
    if (st.lastBeat >= 0) {
      const gap = st.clock - st.lastBeat;
      const one = gap / Math.max(1, Math.round(gap / st.period));
      if (gap < MAX_GAP && one > MIN_PERIOD && one < MAX_PERIOD) st.period += (one - st.period) * PERIOD_EASE;
    }
    st.lastBeat = st.clock;
    st.pull -= st.beatPos - Math.round(st.beatPos);
  }
  const corr = st.pull * (1 - Math.exp(-dt / PULL_TAU));
  st.pull -= corr;
  st.beatPos += dt / st.period + corr;
  const locked = drive > 0 && st.lastBeat >= 0 && st.clock - st.lastBeat < BEAT_FRESH ? 1 : 0;
  st.lock = easeEnvelope(st.lock, locked, dt, LOCK_TAU);
}
