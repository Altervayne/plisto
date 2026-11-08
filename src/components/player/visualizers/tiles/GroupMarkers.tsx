// -- Style Imports --
import styles from "./GroupMarkers.module.css";

/** The dots on a group chip or tab: filled when the group holds the active kind, ringed when it holds the set-aside default. */
export function GroupMarkers({ active, setAside }: { active?: boolean; setAside?: boolean }) {
  if (!active && !setAside) return null;
  return (
    <span className={styles.markers} aria-hidden="true">
      {active ? <span className={styles.dot} /> : null}
      {setAside ? <span className={`${styles.dot} ${styles.ring}`} /> : null}
    </span>
  );
}
