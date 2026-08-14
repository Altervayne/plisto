// -- Framework Imports --
import type { ButtonHTMLAttributes } from "react";

// -- Style Imports --
import styles from "./PrimaryButton.module.css";

/**
 * The solid-accent button atom. Keep at most one mounted per view (the single accent). `cta` is the
 * hero variant (more padding, same fill and crisp radius); `block` stretches it to its container
 * width. Both are additive - the bare button is the default primary.
 */
export function PrimaryButton({
  children,
  cta = false,
  block = false,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { cta?: boolean; block?: boolean }) {
  const className = [styles.primary, cta && styles.cta, block && styles.block]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={className} {...rest}>
      {children}
    </button>
  );
}
