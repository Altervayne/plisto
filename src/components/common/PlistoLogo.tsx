// -- Asset Imports --
// One mark, two lockups: the P + spectrum staff are identical, only the notes differ - platinum glows
// on the dark ground, steel reads on the light one. The theme picks which renders (see the module CSS).
import logoPlatinum from "../../assets/plisto-logo-final.svg";
import logoSteel from "../../assets/plisto-logo-steel.svg";

// -- Style Imports --
import styles from "./PlistoLogo.module.css";

/** The Plisto mark, theme-swapped. `height` in px; width tracks the aspect. Decorative (the wordmark
 * or the surrounding label carries the accessible name). */
export function PlistoLogo({ height = 32 }: { height?: number }) {
  return (
    <span className={styles.logo} style={{ height }}>
      <img src={logoPlatinum} alt="" aria-hidden="true" className={styles.platinum} />
      <img src={logoSteel} alt="" aria-hidden="true" className={styles.steel} />
    </span>
  );
}
