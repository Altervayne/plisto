// -- Framework Imports --
import type { ReactNode } from "react";

// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Style Imports --
import styles from "./NavItem.module.css";

/**
 * One sidebar nav row: an icon, a label, and an optional count. The active row carries the accent
 * text and left bar; the ground stays transparent and hover only warms with the veil.
 */
export function NavItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.item} ${active ? styles.active : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span className={styles.txt}>{label}</span>
      {count != null ? <span className={styles.count}>{formatCount(count)}</span> : null}
    </button>
  );
}
