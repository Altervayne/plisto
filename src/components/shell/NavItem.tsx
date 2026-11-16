// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { TruncatedText } from "../common/TruncatedText/TruncatedText";

// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Style Imports --
import styles from "./NavItem.module.css";

/**
 * One sidebar nav row: an icon, a label, and an optional count. The active row carries the accent
 * text and left bar; the ground stays transparent and hover only warms with the veil. A `tag` sits
 * right after the label, which truncates before the tag does. `chips` fill the row's trailing space,
 * right-aligned, and yield to the label's natural width.
 */
export function NavItem({
  icon,
  label,
  count,
  tag,
  chips,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  tag?: ReactNode;
  chips?: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.item} ${active ? styles.active : ""}${chips ? ` ${styles.hasChips}` : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      {tag ? (
        <span className={styles.tagged}>
          <TruncatedText text={label} className={styles.name} />
          {tag}
        </span>
      ) : (
        <TruncatedText text={label} className={styles.txt} />
      )}
      {chips ? <span className={styles.chips}>{chips}</span> : null}
      {count != null ? <span className={styles.count}>{formatCount(count)}</span> : null}
    </button>
  );
}
