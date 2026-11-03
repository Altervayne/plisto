// -- Framework Imports --
import type { ButtonHTMLAttributes } from "react";

// -- Style Imports --
import styles from "./QuietButton.module.css";

/**
 * The transparent, veil-on-hover button atom for secondary and non-accent actions. `destructive` tints
 * it the danger red for an action that cannot be undone.
 */
export function QuietButton({
  children,
  destructive = false,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { destructive?: boolean }) {
  return (
    <button
      type="button"
      className={destructive ? `${styles.quiet} ${styles.destructive}` : styles.quiet}
      {...rest}
    >
      {children}
    </button>
  );
}
