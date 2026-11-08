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
 * The visualizer layer of a stage, by shown kind: today's Canvas 2D ridge, the WebGL surface for every
 * other kind, or nothing for Off. Every WebGL kind renders the same surface at the same spot, so a switch
 * between them keeps its context. Purely ambient and aria-hidden.
 */
export function Visualizer({
  choice,
  trackId,
  ambient = false,
  coverRef,
  maskRef,
  floorRef,
  hushRefs,
}: {
  choice: VisualizerChoice;
  trackId: number;
  ambient?: boolean;
  coverRef: RefObject<HTMLElement | null>;
  maskRef?: RefObject<HTMLElement | null>;
  floorRef?: RefObject<HTMLElement | null>;
  hushRefs?: readonly RefObject<HTMLElement | null>[];
}) {
  const palette = useCoverPalette(trackId);
  const colors = useMemo(() => paletteFloats(palette), [palette]);
  const { shown } = choice;

  if (shown === "off") return null;
  if (shown === "ridge") return <SpectrumRidge tall={ambient} />;
  return (
    <GlVisualizer
      kind={shown}
      ambient={ambient}
      coverRef={coverRef}
      maskRef={maskRef}
      floorRef={floorRef}
      hushRefs={hushRefs}
      palette={colors}
      reactivity={choice.reactivity}
      pixels={choice.pixels}
      mirrored={choice.spectrumLayout === "mirrored"}
      onFail={choice.onGlFail}
    />
  );
}
