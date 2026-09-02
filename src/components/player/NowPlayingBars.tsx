// -- Style Imports --
import styles from "./NowPlayingBars.module.css";

/**
 * The three-bar equalizer glyph marking the row the engine is on. Neutral ink, not accent - it reads
 * "this one" by motion and weight, leaving the seek fill the sole lit mark. The bars breathe on a loop
 * and hold still under a reduced-motion preference.
 */
export function NowPlayingBars() {
  return (
    <span className={styles.bars} aria-hidden="true">
      <span className={styles.bar} />
      <span className={styles.bar} />
      <span className={styles.bar} />
    </span>
  );
}
