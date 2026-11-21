// -- Framework Imports --
import { useMemo } from "react";
import type { RefObject } from "react";

// -- Component Imports --
import { GlVisualizer } from "./GlVisualizer";
import { SpectrumRidge } from "../SpectrumRidge";
import { PluginStage } from "./plugin/PluginStage";

// -- Hook Imports --
import { useCoverPalette } from "../../covers/useCoverPalette";
import { useStreamArtRev } from "../../../state/player/store";

// -- Local Imports --
import { seedPalette } from "./coverSeed";
import { paletteFloats } from "./visualizerPalette";
import type { VisualizerChoice } from "./useVisualizerChoice";

// -- State Imports --
import { isGlKind } from "../../../state/player/visualizerKind";
import { pluginVisualizer } from "../../../state/player/pluginVisualizers";
import { isFrameWanted, usePluginFrames } from "../../../state/player/pluginVis/frameCache";

/**
 * The visualizer layer of a stage, by shown kind: today's Canvas 2D ridge, the WebGL surface for every
 * other built-in kind, or nothing for Off. Every WebGL kind renders the same surface at the same spot, so
 * a switch between them keeps its context. A plugin kind draws in its own frame beside them: the frame of
 * a kind the dip aims at mounts hidden while the outgoing kind still draws, and the last frame to leave is
 * kept a while. Purely ambient and aria-hidden.
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
  const palette = useCoverPalette(trackId, useStreamArtRev());
  const { coverless } = choice;
  const colors = useMemo(
    () => paletteFloats(coverless ? seedPalette(trackId) : palette),
    [coverless, trackId, palette],
  );
  const { shown } = choice;
  const surface = ambient ? "ambient" : "player";
  const frames = usePluginFrames(surface, shown);

  let builtIn = null;
  if (shown === "ridge") builtIn = <SpectrumRidge tall={ambient} />;
  else if (isGlKind(shown)) {
    builtIn = (
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

  return (
    <>
      {builtIn}
      {frames.map((kind) => {
        const descriptor = pluginVisualizer(kind);
        if (!descriptor) return null;
        return (
          <PluginStage
            key={kind}
            descriptor={descriptor}
            surface={surface}
            shown={shown === kind}
            ambient={ambient}
            coverRef={coverRef}
            maskRef={maskRef}
            floorRef={floorRef}
            hushRefs={hushRefs}
            palette={colors}
            pixels={choice.pixels}
            reactivity={choice.reactivity}
            // A kept frame failing is not the stage's concern; only a kind still aimed at falls back.
            onFail={() => {
              if (isFrameWanted(surface, kind)) choice.onGlFail();
            }}
          />
        );
      })}
    </>
  );
}
