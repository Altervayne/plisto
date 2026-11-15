// -- Icon Imports --
import { Waves } from "lucide-react";

// -- Component Imports --
import { IconToggle } from "../common/IconToggle";
import { Tooltip } from "../common/Tooltip";

// -- State Imports --
import { useVisualizerSheet, useVisualizerSheetOpen } from "../../state/player/visualizerSheet";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The button beside Sound that opens the visualizer sheet. It hands itself to the sheet as its anchor, so
 * a second press closes the sheet and Escape returns focus here. Pressed while the sheet is open.
 */
export function VisualizerButton() {
  const open = useVisualizerSheetOpen();
  const t = useT();

  return (
    <Tooltip label={t((d) => d.player.visualizer)}>
      <IconToggle
        pressed={open}
        aria-label={t((d) => d.player.visualizer)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => useVisualizerSheet.getState().toggle(event.currentTarget)}
      >
        <Waves size={18} strokeWidth={1.8} />
      </IconToggle>
    </Tooltip>
  );
}
