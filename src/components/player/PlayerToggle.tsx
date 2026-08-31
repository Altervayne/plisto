// -- Icon Imports --
import { HeadphoneOff, Headphones } from "lucide-react";

// -- Component Imports --
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- State Imports --
import { usePlayerEnabled, useSetPlayerEnabled } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerToggle.module.css";

/**
 * The quiet switch at the foot of the rail that shows or hides the scattered play affordances - the
 * row triangles, the cover disc, the menu Play entries. It never touches the engine: hiding the
 * controls leaves any playing track running, still reachable from the mini above. The glyph swaps
 * outright between states rather than dimming, so on and off read apart at a glance; it stays inky,
 * never accent, so it does not compete with the one lit accent a view already holds. It mirrors the
 * IconButton vocabulary - transparent at rest, a veil on hover - with a two-state ink the atom cannot
 * carry.
 */
export function PlayerToggle() {
  const enabled = usePlayerEnabled();
  const setEnabled = useSetPlayerEnabled();
  const t = useT();

  const label = enabled ? t((d) => d.player.hideControls) : t((d) => d.player.showControls);

  return (
    <Tooltip label={label} placement="right">
      <button
        type="button"
        className={styles.toggle}
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        onClick={() => setEnabled(!enabled)}
      >
        {enabled ? (
          <Headphones size={17} strokeWidth={1.8} />
        ) : (
          <HeadphoneOff size={17} strokeWidth={1.8} />
        )}
      </button>
    </Tooltip>
  );
}
