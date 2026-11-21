// -- Local Imports --
import { VISUALIZER_VIEWS } from "./visualizerViews";

// -- State Imports --
import { pluginVisualizer } from "../../../state/player/pluginVisualizers";
import { isVisualizerKind } from "../../../state/player/visualizerRegistry";

// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

/** A kind's name: a built-in's localized label, a plugin kind's declared name, else the id itself. */
export function kindName(kind: VisualizerKind, t: Translate): string {
  if (isVisualizerKind(kind)) return t(VISUALIZER_VIEWS[kind].label);
  return pluginVisualizer(kind)?.name ?? kind;
}
