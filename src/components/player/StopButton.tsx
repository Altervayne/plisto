// -- Icon Imports --
import { Square } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";

// -- State Imports --
import { usePlayerActions } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The full-stop control: stops playback and clears the now-playing. The engine drops the current track,
 * so every now-playing surface - the mini, the tray block, the pop-out widget - empties at once. A thin
 * IconButton, self-wired to the stop action, so it drops in wherever a stop belongs.
 */
export function StopButton() {
  const actions = usePlayerActions();
  const t = useT();

  return (
    <IconButton aria-label={t((d) => d.player.stop)} onClick={() => actions.stop()}>
      <Square size={16} strokeWidth={1.8} />
    </IconButton>
  );
}
