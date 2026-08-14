// -- Style Imports --
import styles from "./CoverBadge.module.css";

/** The status a cover badge signals. Drives the tone dot color only. */
export type BadgeTone = "warn" | "good";

/**
 * A glass status pill over album art: a tone dot and a short label. It floats over arbitrary art,
 * so the pill's tint and text are the fixed white-on-glass over-art palette, theme-independent like
 * the cover-action bar. Only the dot draws a theme token, so warn and good stay legible in both.
 */
export function CoverBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  return (
    <span className={styles.badge}>
      <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />
      {label}
    </span>
  );
}
