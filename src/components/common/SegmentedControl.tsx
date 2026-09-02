// -- Framework Imports --
import type { ReactNode } from "react";

// -- Style Imports --
import styles from "./SegmentedControl.module.css";

/**
 * One choice in the control: a stable value and its already-localized label. With an `icon`, the chip
 * shows the icon and the label becomes its accessible name, so an icon-only toggle stays labelled.
 */
export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

/**
 * A segmented control: a soft recess holding chips, the active one raised. The accent is deliberately
 * absent - the raised chip alone marks the choice, so a screen keeps its restraint with no solid CTA.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.control} role="group" aria-label={label}>
      {segments.map((segment) => (
        <button
          key={segment.value}
          type="button"
          className={`${styles.segment} ${segment.icon ? styles.iconChip : ""} ${
            value === segment.value ? styles.active : ""
          }`}
          aria-pressed={value === segment.value}
          aria-label={segment.icon ? segment.label : undefined}
          onClick={() => onChange(segment.value)}
        >
          {segment.icon ?? segment.label}
        </button>
      ))}
    </div>
  );
}
