// -- Framework Imports --
import type { KeyboardEvent, MouseEvent } from "react";

// -- Style Imports --
import styles from "./CoverBadge.module.css";

/** The status a cover badge signals. Drives the tone dot color only. */
export type BadgeTone = "warn" | "good";

/**
 * A glass status pill over album art: a tone dot and a short label. It floats over arbitrary art,
 * so the pill's tint and text are the fixed white-on-glass over-art palette, theme-independent like
 * the cover-action bar. Only the dot draws a theme token, so warn and good stay legible in both.
 * With `onClick` the pill is its own click target and stops the click reaching the tile under it.
 */
export function CoverBadge({
  tone,
  label,
  onClick,
}: {
  tone: BadgeTone;
  label: string;
  onClick?: () => void;
}) {
  const dot = <span className={`${styles.dot} ${styles[tone]}`} aria-hidden="true" />;
  if (!onClick) {
    return (
      <span className={styles.badge}>
        {dot}
        {label}
      </span>
    );
  }
  return (
    <span
      className={`${styles.badge} ${styles.action}`}
      role="button"
      tabIndex={0}
      onClick={(event: MouseEvent) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {dot}
      {label}
    </span>
  );
}
