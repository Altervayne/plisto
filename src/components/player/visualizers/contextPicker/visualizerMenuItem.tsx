/*
 * The "Visualizer..." row the album, track and Browse menus share: it opens the visualizer popover in the
 * menu's side panel. An opened file (negative id) is not in the library and has no tier to store a
 * default in, so it gets no row.
 */

// -- Icon Imports --
import { Waves } from "lucide-react";

// -- Component Imports --
import { VisualizerPopover } from "./VisualizerPopover";

// -- Type Imports --
import type { MenuItem } from "../../../common/ContextMenu";
import type { Translate } from "../../../../i18n";
import type { VisualizerScope } from "./useVisualizerPopoverModel";

export function visualizerMenuItem(scope: VisualizerScope, t: Translate): MenuItem | null {
  if ("track" in scope && scope.track < 0) return null;
  return {
    icon: <Waves size={16} strokeWidth={1.8} />,
    label: t((d) => d.player.visualizerMenu),
    onSelect: () => {},
    panel: (api) => <VisualizerPopover scope={scope} {...api} />,
  };
}
