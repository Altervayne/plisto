/*
 * Which WebGL kinds have their programs in the browser's shader cache, so a stage can draw them without
 * stalling. A kind that draws without WebGL is always warm.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { isGlKind, type VisualizerKind } from "../../../../state/player/visualizerKind";

interface WarmStore {
  warmed: ReadonlySet<VisualizerKind>;
}

export const useWarmState = create<WarmStore>(() => ({ warmed: new Set() }));

/** Whether `kind` is warm in a snapshot of the warmed set. */
export function warmIn(warmed: ReadonlySet<VisualizerKind>, kind: VisualizerKind): boolean {
  return !isGlKind(kind) || warmed.has(kind);
}

/** Whether a kind can draw its first frame without a compile stall. */
export function isWarm(kind: VisualizerKind): boolean {
  return !isGlKind(kind) || useWarmState.getState().warmed.has(kind);
}

export function markWarm(kind: VisualizerKind): void {
  if (useWarmState.getState().warmed.has(kind)) return;
  useWarmState.setState((s) => ({ warmed: new Set(s.warmed).add(kind) }));
}

export const useIsWarm = (kind: VisualizerKind) => useWarmState((s) => warmIn(s.warmed, kind));
