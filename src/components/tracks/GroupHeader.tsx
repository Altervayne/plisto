// -- Framework Imports --
import type { CSSProperties } from "react";

// -- Icon Imports --
import { ChevronRight } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./GroupHeader.module.css";

/**
 * A group section header inside the grouped track list: the group label with its member count trailing,
 * over a band of top space that parts it from the group above. The whole row is the collapse toggle; the
 * chevron is the affordance, dissolving in until the row is hovered or focused and rotating flat when the
 * group is collapsed. Neutral ink throughout - the accent stays reserved for selection and play. `first`
 * drops the top space so the leading group sits flush. The top space rides in the padding, not a margin,
 * so the virtualizer measures the real height; `measureRef` and `index` feed that measurement.
 */
export function GroupHeader({
  label,
  count,
  collapsed,
  first,
  index,
  style,
  measureRef,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  first: boolean;
  index: number;
  style: CSSProperties;
  measureRef: (node: Element | null) => void;
  onToggle: () => void;
}) {
  const t = useT();
  const cls = [styles.header, first ? styles.first : "", collapsed ? styles.collapsed : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      ref={measureRef}
      data-index={index}
      className={cls}
      style={style}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <ChevronRight className={styles.chevron} size={16} strokeWidth={2} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      <span className={styles.count}>{t((d) => d.tracks.groupCount, { n: count })}</span>
    </button>
  );
}
