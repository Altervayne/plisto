// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// -- State Imports --
import { createDip, dipOpacity, stepDip, type DipReason, type DipState } from "../../../state/player/visualizerDip";
import type { VisualizerKind } from "../../../state/player/visualizerKind";
import { isPluginKindId, pluginVisualizer } from "../../../state/player/pluginVisualizers";
import { stageAim, usePluginPhase, wantFrame } from "../../../state/player/pluginVis/frameCache";
import type { StageSurface } from "../../../state/player/pluginVis/frameCache";

// The longest step one frame may take, so a stalled frame never jumps the dip.
const MAX_DT = 0.05;

/**
 * Drives the dip between visualizers on a stage. The caller holds the shown kind and this hook moves it
 * through `onSwap` at the zero point. Each frame writes the opacity to `--viz-dip` on the stage, where the
 * visualizer layers and the queue plate read it, so the dip never re-renders the stage. The frame loop
 * runs only while the dip moves, and a reduced-motion preference swaps at once. A plugin kind is aimed at
 * through its frame on this `surface`: the outgoing kind holds until that frame draws, and the fallback
 * stands in while it is slow or gone.
 */
export function useVisualizerDip(
  stageRef: RefObject<HTMLElement | null>,
  aimed: VisualizerKind,
  aimedReady: boolean,
  reason: DipReason,
  shown: VisualizerKind,
  onSwap: (shown: VisualizerKind) => void,
  surface: StageSurface,
): void {
  const phase = usePluginPhase(surface, aimed);
  // Keeps the frame mounting while the fallback shows, so a late first frame can still swap in.
  useEffect(() => (isPluginKindId(aimed) ? wantFrame(surface, aimed) : undefined), [surface, aimed]);
  const { target, ready } = stageAim(aimed, aimedReady, phase, pluginVisualizer(aimed) !== undefined);
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
