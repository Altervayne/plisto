/*
 * The dip between visualizers: the stage fades to its ground, swaps kinds at zero, and fades back up. Only
 * one kind is ever live, so the swap costs nothing extra. Pure and driven by elapsed time, so a frame loop
 * steps it and tests replay it exactly.
 *
 * A new target mid-dip turns round from the current position and never snaps. A target that is not ready
 * reads as the shown kind, so the outgoing kind holds at full opacity until the incoming one can draw.
 * Off draws nothing, so it counts as already at zero.
 */

// -- State Imports --
import type { VisualizerKind } from "./visualizerKind";

/** The length of a full dip, down and back up, in seconds. A track boundary dips slower than a pick. */
export const DIP_SECS = { manual: 0.6, boundary: 1.5 } as const;

export type DipReason = keyof typeof DIP_SECS;

export interface DipState {
  // The kind on the stage now.
  shown: VisualizerKind;
  // The kind the dip is heading for. Equal to `shown` once it has swapped, or while the target is not ready.
  target: VisualizerKind;
  // The position along the dip: 1 is full opacity, 0 is the swap point.
  p: number;
  // Seconds for one leg, down or up.
  leg: number;
}

export interface DipInput {
  target: VisualizerKind;
  // False while the target cannot draw yet, for example while its cover pixels load.
  ready: boolean;
  reason: DipReason;
  reduced: boolean;
}

export interface DipStep {
  state: DipState;
  // The shown kind changed during this step.
  swapped: boolean;
}

// Absorbs float drift so a leg stepped in whole frames lands exactly on its end.
const EPS = 1e-9;

/** A dip at rest on `kind`. */
export function createDip(kind: VisualizerKind): DipState {
  return { shown: kind, target: kind, p: 1, leg: DIP_SECS.manual / 2 };
}

/**
 * Advances the dip by `dt` seconds toward `input.target`. The leg length is taken from the reason when the
 * target changes and kept until it changes again. Time left over at the swap carries into the rise.
 */
export function stepDip(state: DipState, input: DipInput, dt: number): DipStep {
  const target = input.ready ? input.target : state.shown;
  const leg = target === state.target ? state.leg : DIP_SECS[input.reason] / 2;
  if (input.reduced) {
    return { state: { shown: target, target, p: 1, leg }, swapped: target !== state.shown };
  }

  let { shown, p } = state;
  let travel = dt / leg;
  let swapped = false;
  if (shown !== target) {
    if (shown === "off") {
      p = 0;
    } else {
      const fall = Math.min(p, travel);
      p -= fall;
      travel -= fall;
      if (p > EPS) return { state: { shown, target, p, leg }, swapped };
    }
    shown = target;
    p = 0;
    swapped = true;
    // Off has nothing to fade in, so it settles at once.
    if (shown === "off") return { state: { shown, target, p: 1, leg }, swapped };
  }

  p = Math.min(1, p + travel);
  if (p > 1 - EPS) p = 1;
  return { state: { shown, target, p, leg }, swapped };
}

/** The stage opacity for a dip: a smoothstep of its position, and always zero while Off is shown. */
export function dipOpacity(state: DipState): number {
  if (state.shown === "off") return 0;
  const p = state.p;
  return p * p * (3 - 2 * p);
}
