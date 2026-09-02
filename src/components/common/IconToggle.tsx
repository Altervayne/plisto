// -- Framework Imports --
import type { ButtonHTMLAttributes } from "react";

// -- Style Imports --
import styles from "./IconToggle.module.css";

/**
 * A two-state icon control: a bare glyph at rest, a raised chip when pressed. The sibling of IconButton
 * for a control that stays on - shuffle, repeat - so the lit state reads by material, not a second color.
 * `pressed` drives both the chip and `aria-pressed`; an `aria-label` is required, since the glyph carries
 * no text a screen reader can read. `size` tightens the padding for a cramped row without touching the
 * default.
 */
export function IconToggle({
  pressed,
  size = "md",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  "aria-label": string;
  pressed: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      className={size === "sm" ? `${styles.toggle} ${styles.sm}` : styles.toggle}
      aria-pressed={pressed}
      {...rest}
    >
      {children}
    </button>
  );
}
