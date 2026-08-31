// -- Icon Imports --
import { HeadphoneOff, Headphones } from "lucide-react";

// -- State Imports --
import { usePlayerEnabled, useSetPlayerEnabled } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerToggle.module.css";

/**
 * The switch at the foot of the rail that shows or hides the scattered play affordances - the row
 * triangles, the cover disc, the menu Play entries. It never touches the engine: hiding the controls
 * leaves any playing track running, still reachable from the mini above. It reads as a full-width nav
 * row alongside Settings; the glyph swaps outright between states and the label names the action, so
 * on and off read apart at a glance. Inky, never accent, so it does not compete with the one lit
 * accent a view already holds.
 */
export function PlayerToggle() {
  const enabled = usePlayerEnabled();
  const setEnabled = useSetPlayerEnabled();
  const t = useT();

  const label = enabled ? t((d) => d.player.hideControls) : t((d) => d.player.showControls);

  return (
    <button
      type="button"
      className={styles.toggle}
      role="switch"
      aria-checked={enabled}
      onClick={() => setEnabled(!enabled)}
    >
      {enabled ? (
        <Headphones size={17} strokeWidth={1.8} />
      ) : (
        <HeadphoneOff size={17} strokeWidth={1.8} />
      )}
      <span className={styles.txt}>{label}</span>
    </button>
  );
}
