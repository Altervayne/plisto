// -- Framework Imports --
import type { ReactNode } from "react";

// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Style Imports --
import styles from "./NavItem.module.css";

/**
 * One sidebar nav row: an icon, a label, and an optional count. The active row carries the accent
 * text and left bar; the ground stays transparent and hover only warms with the veil. A `tag` sits
 * right after the label, which truncates before the tag does.
 */
export function NavItem({
  icon,
  label,
  count,
  tag,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  tag?: ReactNode;
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
      {tag ? (
        <span className={styles.tagged}>
          <span className={styles.name}>{label}</span>
          {tag}
        </span>
      ) : (
        <span className={styles.txt}>{label}</span>
      )}
      {count != null ? <span className={styles.count}>{formatCount(count)}</span> : null}
    </button>
  );
}
