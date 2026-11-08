// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// -- State Imports --
import { createDip, dipOpacity, stepDip, type DipReason, type DipState } from "../../../state/player/visualizerDip";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

// The longest step one frame may take, so a stalled frame never jumps the dip.
const MAX_DT = 0.05;

/**
 * Drives the dip between visualizers on a stage. The caller holds the shown kind and this hook moves it
 * through `onSwap` at the zero point. Each frame writes the opacity to `--viz-dip` on the stage, where the
 * visualizer layers and the queue plate read it, so the dip never re-renders the stage. The frame loop
 * runs only while the dip moves, and a reduced-motion preference swaps at once.
 */
export function useVisualizerDip(
  stageRef: RefObject<HTMLElement | null>,
  target: VisualizerKind,
  ready: boolean,
  reason: DipReason,
  shown: VisualizerKind,
  onSwap: (shown: VisualizerKind) => void,
): void {
  const dip = useRef<DipState | null>(null);
  if (dip.current == null) dip.current = createDip(shown);

  useEffect(() => {
    const start = dip.current;
    if (!start || ((!ready || target === start.shown) && start.p === 1)) return;
    let state: DipState = start;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(MAX_DT, Math.max(0, (now - last) / 1000));
      last = now;
      const step = stepDip(state, { target, ready, reason, reduced }, dt);
      state = step.state;
      dip.current = state;
      stageRef.current?.style.setProperty("--viz-dip", String(dipOpacity(state)));
      if (step.swapped) onSwap(state.shown);
      if (state.p === 1 && state.shown === state.target) return;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [stageRef, target, ready, reason, onSwap]);
}
