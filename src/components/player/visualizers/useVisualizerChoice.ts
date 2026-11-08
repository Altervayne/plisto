// -- Framework Imports --
import { useCallback, useState } from "react";
import type { RefObject } from "react";

// -- Hook Imports --
import { useCoverPixels } from "./useCoverPixels";
import { useVisualizerDip } from "./useVisualizerDip";

// -- State Imports --
import {
  usePlayerSpectrumLayout,
  usePlayerVisualizer,
  usePlayerVisualizerReactivity,
} from "../../../state/preferences/store";
import type { DipReason } from "../../../state/player/visualizerDip";
import {
  needsCoverPixels,
  type Reactivity,
  type SpectrumLayout,
  type VisualizerKind,
} from "../../../state/player/visualizerKind";

// -- Local Imports --
import { dipReason, dipTarget, mountedKind, type DipLatch } from "./visualizerTarget";

/**
 * What one surface draws: the kind on the stage, which trails the pick through a dip, how hard it moves,
 * the dot spectrum's layout, the cover pixels the art-drawing kinds read, and the failure hook.
 */
export interface VisualizerChoice {
  shown: VisualizerKind;
  reactivity: Reactivity;
  spectrumLayout: SpectrumLayout;
  pixels: ImageBitmap | null;
  // Called by the WebGL surface when its context is missing or lost, or a shader fails.
  onGlFail: () => void;
}

/**
 * Resolves the picked visualizer for the stage at `stageRef`, showing track `trackId` with the cover at
 * `coverSrc`, and dips the stage from the shown kind to it. Cover pixels load while either end of the dip
 * draws them, so the outgoing kind keeps its art on the way down. A WebGL failure drops that pick to Ridge
 * until the pick changes, so choosing it again retries.
 */
export function useVisualizerChoice(
  coverSrc: string | null,
  trackId: number,
  stageRef: RefObject<HTMLElement | null>,
): VisualizerChoice {
  const picked = usePlayerVisualizer();
  const reactivity = usePlayerVisualizerReactivity();
  const spectrumLayout = usePlayerSpectrumLayout();
  const [failed, setFailed] = useState<VisualizerKind | null>(null);
  const [shown, setShown] = useState(() => mountedKind(picked, coverSrc));
  const wantsCover = needsCoverPixels(picked) || needsCoverPixels(shown);
  const { pixels, state } = useCoverPixels(wantsCover ? coverSrc : null);
  const onGlFail = useCallback(() => setFailed(picked), [picked]);
  const { target, ready } = dipTarget(picked, failed === picked, state);
  const reason = useDipReason(trackId, target);
  useVisualizerDip(stageRef, target, ready, reason, shown, setShown);
  return { shown, reactivity, spectrumLayout, pixels, onGlFail };
}

/** The reason for the dip toward `target`, latched while the target holds. */
function useDipReason(trackId: number, target: VisualizerKind): DipReason {
  const [latch, setLatch] = useState<DipLatch>({ trackId, target, reason: "manual" });
  if (latch.trackId === trackId && latch.target === target) return latch.reason;
  const next = { trackId, target, reason: dipReason(latch, trackId, target) };
  setLatch(next);
  return next.reason;
}
