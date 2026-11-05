// -- Framework Imports --
import { useCallback, useState } from "react";

// -- Hook Imports --
import { useCoverPixels } from "./useCoverPixels";

// -- State Imports --
import {
  usePlayerSpectrumLayout,
  usePlayerVisualizer,
  usePlayerVisualizerReactivity,
} from "../../../state/preferences/store";
import {
  effectiveVisualizerKind,
  needsCoverPixels,
  type Reactivity,
  type SpectrumLayout,
  type VisualizerKind,
} from "../../../state/player/visualizerKind";

/**
 * What one surface draws: the kind after its fallbacks, how hard it moves, the dot spectrum's layout, the
 * cover pixels the art-drawing kinds read, and the failure hook.
 */
export interface VisualizerChoice {
  kind: VisualizerKind;
  reactivity: Reactivity;
  spectrumLayout: SpectrumLayout;
  pixels: ImageBitmap | null;
  // Called by the WebGL surface when its context is missing or lost, or a shader fails.
  onGlFail: () => void;
}

/**
 * Resolves the picked visualizer for one surface showing the cover at `coverSrc`. Cover pixels load only
 * while a kind that draws them is picked. A WebGL failure drops that pick to Ridge until the pick changes,
 * so choosing it again retries.
 */
export function useVisualizerChoice(coverSrc: string | null): VisualizerChoice {
  const picked = usePlayerVisualizer();
  const reactivity = usePlayerVisualizerReactivity();
  const spectrumLayout = usePlayerSpectrumLayout();
  const [failed, setFailed] = useState<VisualizerKind | null>(null);
  const pixels = useCoverPixels(needsCoverPixels(picked) ? coverSrc : null);
  const onGlFail = useCallback(() => setFailed(picked), [picked]);
  const kind = effectiveVisualizerKind(picked, {
    glFailed: failed === picked,
    coverPixels: pixels != null,
  });
  return { kind, reactivity, spectrumLayout, pixels, onGlFail };
}
