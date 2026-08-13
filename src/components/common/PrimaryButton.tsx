// -- Framework Imports --
import type { ButtonHTMLAttributes } from "react";

// -- Style Imports --
import styles from "./PrimaryButton.module.css";

/** The solid-accent button atom. Keep at most one mounted per view (the single accent). */
export function PrimaryButton({
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={styles.primary} {...rest}>
      {children}
    </button>
  );
}
