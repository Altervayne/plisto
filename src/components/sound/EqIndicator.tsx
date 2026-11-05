// -- State Imports --
import { useSoundSettings } from "../../state/sound/useSoundSettings";

// -- Utils Imports --
import { isShaped } from "../../state/sound/presets";

// -- Style Imports --
import styles from "./EqIndicator.module.css";

/**
 * The quiet dot that says the EQ is changing the sound. It shows only while the EQ is on and the curve is
 * not flat, and sits on the corner of the glyph it is placed in. Flat accent, no animation.
 */
export function EqIndicator() {
  const shaped = isShaped(useSoundSettings());
  return shaped ? <span className={styles.dot} data-eq-indicator aria-hidden="true" /> : null;
}
