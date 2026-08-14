// -- Style Imports --
import styles from "./SegmentedControl.module.css";

/** One choice in the control: a stable value and its already-localized label. */
export interface Segment<T extends string> {
  value: T;
  label: string;
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
          className={`${styles.segment} ${value === segment.value ? styles.active : ""}`}
          aria-pressed={value === segment.value}
          onClick={() => onChange(segment.value)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}
