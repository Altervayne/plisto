// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Local Imports --
import { useIsWarm } from "./gl/warmState";
import { CUE_DELAY_MS } from "./visualizerTarget";

// -- State Imports --
import type { VisualizerKind } from "../../../state/player/visualizerKind";
import { pluginLoading, usePluginPhase, type StageSurface } from "../../../state/player/pluginVis/frameCache";

/**
 * Whether to show the loading cue for `kind`: its programs have been missing from the shader cache, or
 * its plugin frame on `surface` has not drawn, for longer than the cue delay. A short wait never shows
 * it, so a warm switch stays free of any cue.
 */
export function useLoadingCue(kind: VisualizerKind | null, surface: StageSurface): boolean {
  const phase = usePluginPhase(surface, kind);
  const waiting = !useIsWarm(kind ?? "off") || pluginLoading(kind, phase);
  const [due, setDue] = useState<VisualizerKind | null>(null);
  useEffect(() => {
    if (!waiting || kind == null) return;
    const timer = window.setTimeout(() => setDue(kind), CUE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, kind]);
  return waiting && due === kind;
}
