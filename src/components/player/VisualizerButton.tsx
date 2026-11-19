// -- Icon Imports --
import { Waves } from "lucide-react";

// -- Component Imports --
import { IconToggle } from "../common/IconToggle";
import { Tooltip } from "../common/Tooltip";

// -- State Imports --
import { useVisualizerSheet, useVisualizerSheetOpen } from "../../state/player/visualizerSheet";
import { useVisualizersAllowed } from "../../state/player/visualizerWarning";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The button beside Sound that opens the visualizer sheet. It hands itself to the sheet as its anchor, so
 * a second press closes the sheet and Escape returns focus here. Pressed while the sheet is open. Until the
 * flash warning is acknowledged it is aria-disabled, so it keeps its tooltip, which says why, and a press
 * does nothing. `noticeHere` is false where the notice is not on screen (the compact open-file window), so
 * the tooltip points to the Player instead.
 */
export function VisualizerButton({ noticeHere = true }: { noticeHere?: boolean } = {}) {
  const open = useVisualizerSheetOpen();
  const allowed = useVisualizersAllowed();
  const t = useT();
  const closedTip = noticeHere ? t((d) => d.player.warnButtonTip) : t((d) => d.player.warnElsewhereTip);

  return (
    <Tooltip label={allowed ? t((d) => d.player.visualizer) : closedTip}>
      <IconToggle
        pressed={open}
        aria-label={t((d) => d.player.visualizer)}
        data-visualizer-trigger=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={allowed ? undefined : true}
        onClick={(event) => {
          if (allowed) useVisualizerSheet.getState().toggle(event.currentTarget);
        }}
      >
        <Waves size={18} strokeWidth={1.8} />
      </IconToggle>
    </Tooltip>
  );
}
