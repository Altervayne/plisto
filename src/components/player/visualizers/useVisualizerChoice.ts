// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// -- Hook Imports --
import { useCoverPixels } from "./useCoverPixels";
import { useVisualizerDip } from "./useVisualizerDip";
import { useVisualizerResolution } from "./useVisualizerResolution";

// -- State Imports --
import { usePlayerSpectrumLayout, usePlayerVisualizerReactivity } from "../../../state/preferences/store";
import { useVisualizerDefaults, useVisualizerDefaultsStatus } from "../../../state/player/visualizerDefaults";
import type { DipReason } from "../../../state/player/visualizerDip";
import type { DefaultTier, VisualizerSource } from "../../../state/player/visualizerResolve";
import {
  needsCoverPixels,
  type Reactivity,
  type SpectrumLayout,
  type VisualizerKind,
} from "../../../state/player/visualizerKind";

// -- Local Imports --
import {
  boundaryKey,
  dipReason,
  dipTarget,
  fallbackOf,
  mountedKind,
  shouldRetryDefaults,
  type DipLatch,
  type VisualizerFallback,
} from "./visualizerTarget";

/**
 * What one surface draws: the kind on the stage, which trails the pick through a dip, how hard it moves,
 * the dot spectrum's layout, the cover pixels the art-drawing kinds read, and the failure hook. `picked`
 * and the three fields after it say where the pick came from, and `fallback` why the stage draws
 * something else, for the picker's lines.
 */
export interface VisualizerChoice {
  picked: VisualizerKind;
  source: VisualizerSource;
  defaultKind: VisualizerKind | null;
  defaultTier: DefaultTier | null;
  fallback: VisualizerFallback | null;
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
  const { resolution } = useVisualizerResolution(trackId);
  const { picked, source, defaultKind, defaultTier } = resolution;
  const defaultsStatus = useVisualizerDefaultsStatus();
  const defaultsReady = defaultsStatus === "ready";
  // A failed boot read is tried again at the next track change; load() joins a read already in flight.
  const lastTrack = useRef(trackId);
  useEffect(() => {
    if (shouldRetryDefaults(useVisualizerDefaults.getState().status, lastTrack.current, trackId)) {
      void useVisualizerDefaults.getState().load();
    }
    lastTrack.current = trackId;
  }, [trackId]);
  const reactivity = usePlayerVisualizerReactivity();
  const spectrumLayout = usePlayerSpectrumLayout();
  const [failed, setFailed] = useState<VisualizerKind | null>(null);
  const [shown, setShown] = useState(() => mountedKind(picked, coverSrc));
  const wantsCover = needsCoverPixels(picked) || needsCoverPixels(shown);
  const { pixels, state } = useCoverPixels(wantsCover ? coverSrc : null);
  const onGlFail = useCallback(() => setFailed(picked), [picked]);
  const { target, ready } = dipTarget(picked, failed === picked, state);
  const reason = useDipReason(boundaryKey(trackId, defaultsReady), target);
  useVisualizerDip(stageRef, target, ready, reason, shown, setShown);
  const fallback = fallbackOf(picked, target, failed === picked);
  return { picked, source, defaultKind, defaultTier, fallback, shown, reactivity, spectrumLayout, pixels, onGlFail };
}

/** The reason for the dip toward `target`, latched while the target holds. `trackId` is the boundary key. */
function useDipReason(trackId: number, target: VisualizerKind): DipReason {
  const [latch, setLatch] = useState<DipLatch>({ trackId, target, reason: "manual" });
  if (latch.trackId === trackId && latch.target === target) return latch.reason;
  const next = { trackId, target, reason: dipReason(latch, trackId, target) };
  setLatch(next);
  return next.reason;
}
