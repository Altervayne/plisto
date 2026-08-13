// -- Framework Imports --
import type { ButtonHTMLAttributes } from "react";

// -- Style Imports --
import styles from "./QuietButton.module.css";

/** The transparent, veil-on-hover button atom for secondary and non-accent actions. */
export function QuietButton({
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={styles.quiet} {...rest}>
      {children}
    </button>
  );
}
