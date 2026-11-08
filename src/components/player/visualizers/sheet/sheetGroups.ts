// -- State Imports --
import {
  VISUALIZER_GROUPS,
  type VisualizerGroupId,
  type VisualizerKind,
} from "../../../../state/player/visualizerKind";

// -- Type Imports --
import type { Dict } from "../../../../i18n/en";

/** A run of the strip: one of the picker's sections, or Off on its own at the end. */
export type SheetGroupId = VisualizerGroupId | "off";

export const SHEET_GROUPS: readonly { id: SheetGroupId; kinds: readonly VisualizerKind[] }[] = [
  ...VISUALIZER_GROUPS,
  { id: "off", kinds: ["off"] },
];

/** Each run's localized name, as an accessor for `t`. */
export const SHEET_GROUP_LABELS: Record<SheetGroupId, (d: Dict) => string> = {
  classic: (d) => d.player.visualizerGroupClassic,
  dots: (d) => d.player.visualizerGroupDots,
  fluid: (d) => d.player.visualizerGroupFluid,
  cozy: (d) => d.player.visualizerGroupCozy,
  off: (d) => d.player.visualizerOff,
};
