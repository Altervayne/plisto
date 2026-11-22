// -- Framework Imports --
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";

// -- Hook Imports --
import { useCoverPixels } from "./useCoverPixels";
import { useCoverSeed } from "./useCoverSeed";
import { warmKind } from "./gl/warm";
import { warmIn, useWarmState } from "./gl/warmState";
import { useVisualizerDip } from "./useVisualizerDip";
import { useVisualizerResolution } from "./useVisualizerResolution";

// -- State Imports --
import { usePlayerSpectrumLayout, usePlayerVisualizerReactivity } from "../../../state/preferences/store";
import { useVisualizerDefaults, useVisualizerDefaultsStatus } from "../../../state/player/visualizerDefaults";
import { useVisualizerPreview } from "../../../state/player/visualizerSheet";
import { useVisualizersAllowed } from "../../../state/player/visualizerWarning";
import { isPendingPluginKind } from "../../../state/player/pluginVisualizers";
import { usePluginsListed, usePluginsStore } from "../../../state/plugins/store";
import { reloadPlugins } from "../../../state/plugins/usePluginsSync";
import type { DipReason } from "../../../state/player/visualizerDip";
import { usePluginPhase, type StageSurface } from "../../../state/player/pluginVis/frameCache";
import type { DefaultTier, VisualizerSource } from "../../../state/player/visualizerResolve";
import { isDarkTheme, subscribeTheme } from "../../../theme";
import {
  isDarkOnly,
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
 * Resolves the picked visualizer for the stage at `stageRef` on `surface`, showing track `trackId` with
 * the cover at `coverSrc` and the cover's `status`. A coverless track draws a generated seed image where a
 * cover would be, and dips the stage from the shown kind to it. A kind previewed from the picker takes the
 * pick's place as the dip target until the preview ends; the pick and its fallback line stay as they are.
 * Cover pixels load while either end of the dip draws them, so the outgoing kind keeps its art on the way
 * down. Until the flash warning is acknowledged the stage aims at Off whatever the pick or a preview says,
 * loads no pixels and warms nothing, then dips to the pick once it is. A WebGL failure drops that kind to
 * Ridge until the target changes, so aiming at it again retries. A plugin kind still waiting on the plugins
 * list holds whatever the stage shows, with no fallback line, until the list arrives.
 */
export function useVisualizerChoice(
  coverSrc: string | null,
  status: CoverStatus,
  trackId: number,
  stageRef: RefObject<HTMLElement | null>,
  surface: StageSurface,
): VisualizerChoice {
  const { resolution } = useVisualizerResolution(trackId);
  const { picked, source, defaultKind, defaultTier } = resolution;
  const defaultsStatus = useVisualizerDefaultsStatus();
  const defaultsReady = defaultsStatus === "ready";
  // A failed boot read is tried again at the next track change; load() joins a read already in flight. The
  // plugins list follows the same rule, so a stored plugin kind is never left pending for good.
  const lastTrack = useRef(trackId);
  useEffect(() => {
    if (shouldRetryDefaults(useVisualizerDefaults.getState().status, lastTrack.current, trackId)) {
      void useVisualizerDefaults.getState().load();
    }
    if (shouldRetryDefaults(usePluginsStore.getState().status, lastTrack.current, trackId)) {
      void reloadPlugins();
    }
    lastTrack.current = trackId;
  }, [trackId]);
  const listed = usePluginsListed();
  const reactivity = usePlayerVisualizerReactivity();
  const spectrumLayout = usePlayerSpectrumLayout();
  const preview = useVisualizerPreview();
  // Until the flash warning is acknowledged every kind is held off, whatever the pick or a preview says.
  const allowed = useVisualizersAllowed();
  const wanted: VisualizerKind = allowed ? picked : "off";
  const aimed = allowed ? (preview ?? picked) : "off";
  const [failed, setFailed] = useState<VisualizerKind | null>(null);
  const warmed = useWarmState((s) => s.warmed);
  const warm = (kind: VisualizerKind) => warmIn(warmed, kind);
  const [shown, setShown] = useState(() =>
    isPendingPluginKind(wanted, listed) ? "off" : mountedKind(wanted, warm),
  );
  // The programs reach the shader cache before the dip aims at the kind, so its first frame never stalls.
  useEffect(() => {
    warmKind(aimed);
  }, [aimed]);
  const wantsCover = needsCoverPixels(aimed) || needsCoverPixels(wanted) || needsCoverPixels(shown);
  const cover = useCoverPixels(wantsCover ? coverSrc : null);
  const seedWanted = wantsCover && (status === "coverless" || (status === "present" && cover.state === "absent"));
  // Keyed on the aimed kind, so the seed a dark-only kind needs builds before the swap.
  const rootDark = useSyncExternalStore(subscribeTheme, isDarkTheme);
  const seed = useCoverSeed(seedWanted ? trackId : null, rootDark || isDarkOnly(aimed));
  const composed = wantsCover ? composePixels(cover, seed, status) : cover;
  // The cover kinds draw nothing without pixels, so a pending switch between cover and seed keeps the
  // last art on screen until the next lands.
  const held = useRef<ImageBitmap | null>(null);
  if (composed.pixels) held.current = composed.pixels;
  const { state } = composed;
  const pixels = composed.pixels ?? (state === "pending" ? held.current : null);
  const onGlFail = useCallback(() => setFailed(aimed), [aimed]);
  const aim = dipTarget(aimed, failed === aimed, state, warm);
  const { target } = aim;
  // A not-ready target leaves the outgoing kind at full opacity, so a pending kind holds the stage as it is.
  const ready = aim.ready && !isPendingPluginKind(aimed, listed);
  const reason = useDipReason(boundaryKey(trackId, defaultsReady), target);
  useVisualizerDip(stageRef, target, ready, reason, shown, setShown, surface);
  const pickedTarget = !allowed || isPendingPluginKind(picked, listed)
    ? picked
    : preview == null
      ? target
      : dipTarget(picked, failed === picked, state).target;
  // A plugin pick past the slow mark shows the fallback while it compiles on.
  const loading = usePluginPhase(surface, picked) === "slow" && allowed && preview == null;
  const fallback = loading ? "loading" : fallbackOf(picked, pickedTarget, failed === picked);
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
