// -- Type Imports --
import type { Dict } from "../../../i18n/en";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

const LABELS: Record<VisualizerKind, (d: Dict) => string> = {
  ridge: (d) => d.player.visualizerRidge,
  terrain: (d) => d.player.visualizerTerrain,
  liquid: (d) => d.player.visualizerLiquid,
  warp: (d) => d.player.visualizerWarp,
  nebula: (d) => d.player.visualizerNebula,
  bloom: (d) => d.player.visualizerBloom,
  halftone: (d) => d.player.visualizerHalftone,
  "dot-spectrum": (d) => d.player.visualizerDotSpectrum,
  "dot-cover": (d) => d.player.visualizerDotCover,
  ink: (d) => d.player.visualizerInk,
  mercury: (d) => d.player.visualizerMercury,
  glass: (d) => d.player.visualizerGlass,
  silk: (d) => d.player.visualizerSilk,
  off: (d) => d.player.visualizerOff,
};

/** The localized name of a visualizer, as an accessor for `t`. */
export function visualizerLabel(kind: VisualizerKind): (d: Dict) => string {
  return LABELS[kind];
}
