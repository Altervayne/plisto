// -- Framework Imports --
import { useMemo } from "react";
import type { RefObject } from "react";

// -- Component Imports --
import { GlVisualizer } from "./GlVisualizer";
import { SpectrumRidge } from "../SpectrumRidge";

// -- Hook Imports --
import { useCoverPalette } from "../../covers/useCoverPalette";

// -- Local Imports --
import { paletteFloats } from "./visualizerPalette";
import type { VisualizerChoice } from "./useVisualizerChoice";

/**
 * The visualizer layer of a stage, by resolved kind: today's Canvas 2D ridge, the WebGL surface for
 * every other kind, or nothing for Off. Every WebGL kind renders the same surface at the same spot, so a
 * switch between them keeps its context. Purely ambient and aria-hidden.
 */
export function Visualizer({
  choice,
  trackId,
  ambient = false,
  coverRef,
  maskRef,
}: {
  choice: VisualizerChoice;
  trackId: number;
  ambient?: boolean;
  coverRef: RefObject<HTMLElement | null>;
  maskRef?: RefObject<HTMLElement | null>;
}) {
  const palette = useCoverPalette(trackId);
  const colors = useMemo(() => paletteFloats(palette), [palette]);
  const { kind } = choice;

  if (kind === "off") return null;
  if (kind === "ridge") return <SpectrumRidge tall={ambient} />;
  return (
    <GlVisualizer
      kind={kind}
      ambient={ambient}
      coverRef={coverRef}
      maskRef={maskRef}
      palette={colors}
      pixels={choice.pixels}
      onFail={choice.onGlFail}
    />
  );
}
