// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

// -- Hook Imports --
import { useCoverPixels } from "./useCoverPixels";
import { useCoverSeed } from "./useCoverSeed";
import { useVisualizerDip } from "./useVisualizerDip";
import { useVisualizerResolution } from "./useVisualizerResolution";

// -- State Imports --
import { usePlayerSpectrumLayout, usePlayerVisualizerReactivity } from "../../../state/preferences/store";
import { useVisualizerDefaults, useVisualizerDefaultsStatus } from "../../../state/player/visualizerDefaults";
import { useVisualizerPreview } from "../../../state/player/visualizerSheet";
import type { DipReason } from "../../../state/player/visualizerDip";
import type { DefaultTier, VisualizerSource } from "../../../state/player/visualizerResolve";
import {
  needsCoverPixels,
  type Reactivity,
  type SpectrumLayout,
  type VisualizerKind,
} from "../../../state/player/visualizerKind";

// -- Type Imports --
import type { CoverStatus } from "../../tracks/coverStatus";

// -- Local Imports --
import {
  boundaryKey,
  composePixels,
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
  // True once the track is known to have no cover, so the stage paints with the seed's palette.
  coverless: boolean;
  // Called by the WebGL surface when its context is missing or lost, or a shader fails.
  onGlFail: () => void;
}

/**
 * Resolves the picked visualizer for the stage at `stageRef`, showing track `trackId` with the cover at
 * `coverSrc` and the cover's `status`. A coverless track draws a generated seed image where a cover would
 * be, and dips the stage from the shown kind to it. A kind previewed from the picker takes the
 * pick's place as the dip target until the preview ends; the pick and its fallback line stay as they are.
 * Cover pixels load while either end of the dip draws them, so the outgoing kind keeps its art on the way
 * down. A WebGL failure drops that kind to Ridge until the target changes, so aiming at it again retries.
 */
export function useVisualizerChoice(
  coverSrc: string | null,
  status: CoverStatus,
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
  const preview = useVisualizerPreview();
  const aimed = preview ?? picked;
  const [failed, setFailed] = useState<VisualizerKind | null>(null);
  const [shown, setShown] = useState(() => mountedKind(picked));
  const wantsCover = needsCoverPixels(aimed) || needsCoverPixels(picked) || needsCoverPixels(shown);
  const cover = useCoverPixels(wantsCover ? coverSrc : null);
  const seedWanted = wantsCover && (status === "coverless" || (status === "present" && cover.state === "absent"));
  const seed = useCoverSeed(seedWanted ? trackId : null);
  const composed = wantsCover ? composePixels(cover, seed, status) : cover;
  // The cover kinds draw nothing without pixels, so a pending switch between cover and seed keeps the
  // last art on screen until the next lands.
  const held = useRef<ImageBitmap | null>(null);
  if (composed.pixels) held.current = composed.pixels;
  const { state } = composed;
  const pixels = composed.pixels ?? (state === "pending" ? held.current : null);
  const onGlFail = useCallback(() => setFailed(aimed), [aimed]);
  const { target, ready } = dipTarget(aimed, failed === aimed, state);
  const reason = useDipReason(boundaryKey(trackId, defaultsReady), target);
  useVisualizerDip(stageRef, target, ready, reason, shown, setShown);
  const pickedTarget = preview == null ? target : dipTarget(picked, failed === picked, state).target;
  const fallback = fallbackOf(picked, pickedTarget, failed === picked);
  return {
    picked,
    source,
    defaultKind,
    defaultTier,
    fallback,
    shown,
    reactivity,
    spectrumLayout,
    pixels,
    coverless: status === "coverless",
    onGlFail,
  };
}

/** The reason for the dip toward `target`, latched while the target holds. `trackId` is the boundary key. */
function useDipReason(trackId: number, target: VisualizerKind): DipReason {
  const [latch, setLatch] = useState<DipLatch>({ trackId, target, reason: "manual" });
  if (latch.trackId === trackId && latch.target === target) return latch.reason;
  const next = { trackId, target, reason: dipReason(latch, trackId, target) };
  setLatch(next);
  return next.reason;
}
