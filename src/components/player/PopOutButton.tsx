// -- Icon Imports --
import { PictureInPicture2 } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";

// -- IPC Imports --
import { toggleNowPlayingWidget } from "../../lib/ipc";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The button that summons the pop-out now-playing widget, dropped into the mini-player and the tray
 * block. A thin IconButton over the toggle command - the same click closes the widget when it is
 * already up, so one control does both.
 */
export function PopOutButton() {
  const t = useT();

  return (
    <IconButton
      aria-label={t((d) => d.player.popOut)}
      onClick={() => void toggleNowPlayingWidget()}
    >
      <PictureInPicture2 size={16} strokeWidth={1.8} />
    </IconButton>
  );
}
