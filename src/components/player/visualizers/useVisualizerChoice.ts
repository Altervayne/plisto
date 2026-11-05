// -- Framework Imports --
import { useCallback, useState } from "react";

// -- Hook Imports --
import { useCoverPixels } from "./useCoverPixels";

// -- State Imports --
import { usePlayerVisualizer } from "../../../state/preferences/store";
import { effectiveVisualizerKind, type VisualizerKind } from "../../../state/player/visualizerKind";

/** What one surface draws: the kind after its fallbacks, the cover pixels Liquid warps, and the failure hook. */
export interface VisualizerChoice {
  kind: VisualizerKind;
  pixels: ImageBitmap | null;
  // Called by the WebGL surface when its context is missing or lost, or a shader fails.
  onGlFail: () => void;
}

/**
 * Resolves the picked visualizer for one surface showing the cover at `coverSrc`. Cover pixels load only
 * while Liquid is picked. A WebGL failure drops that pick to Ridge until the pick changes, so choosing it
 * again retries.
 */
export function useVisualizerChoice(coverSrc: string | null): VisualizerChoice {
  const picked = usePlayerVisualizer();
  const [failed, setFailed] = useState<VisualizerKind | null>(null);
  const pixels = useCoverPixels(picked === "liquid" ? coverSrc : null);
  const onGlFail = useCallback(() => setFailed(picked), [picked]);
  const kind = effectiveVisualizerKind(picked, {
    glFailed: failed === picked,
    coverPixels: pixels != null,
  });
  return { kind, pixels, onGlFail };
}
