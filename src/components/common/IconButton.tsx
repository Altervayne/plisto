// -- Framework Imports --
import type { ButtonHTMLAttributes } from "react";

// -- Style Imports --
import styles from "./IconButton.module.css";

/**
 * The icon-only button atom: transparent at rest, a soft veil on hover, padded square around a lone
 * glyph. The QuietButton's text padding does not fit a bare icon, so this is its icon sibling. An
 * `aria-label` is required - an icon carries no text a screen reader can read.
 */
export function IconButton({
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string }) {
  return (
    <button type="button" className={styles.icon} {...rest}>
      {children}
    </button>
  );
}
