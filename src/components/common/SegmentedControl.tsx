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
 * With `expandActive`, the control fills its width and the active icon chip alone shows its label and
 * grows to take the slack, so an icon-only row reads as a labelled selection without stretching every chip.
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  label,
  expandActive = false,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  expandActive?: boolean;
}) {
  return (
    <div
      className={`${styles.control} ${expandActive ? styles.expand : ""}`}
      role="group"
      aria-label={label}
    >
      {segments.map((segment) => {
        const isActive = value === segment.value;
        // The active icon chip reveals its label only when expanding; every other icon chip stays a
        // square glyph, its label carried by aria-label.
        const withLabel = expandActive && isActive && segment.icon != null;
        return (
          <button
            key={segment.value}
            type="button"
            className={`${styles.segment} ${segment.icon ? styles.iconChip : ""} ${
              isActive ? styles.active : ""
            } ${withLabel ? styles.labelled : ""}`}
            aria-pressed={isActive}
            aria-label={segment.icon && !withLabel ? segment.label : undefined}
            onClick={() => onChange(segment.value)}
          >
            {segment.icon ?? segment.label}
            {withLabel ? <span className={styles.segmentLabel}>{segment.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
