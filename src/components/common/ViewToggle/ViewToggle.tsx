// -- Style Imports --
import styles from "./ViewToggle.module.css";

/** Which library view is showing: the album grid or the track list. */
export type ViewMode = "grid" | "list";

/** The two segments, in display order. */
const SEGMENTS: { value: ViewMode; label: string }[] = [
  { value: "grid", label: "Grid" },
  { value: "list", label: "List" },
];

/**
 * A segmented Grid/List control: a soft recess holding two chips, the active one raised. The accent
 * is deliberately absent - the raised chip alone marks the choice, per the restraint rule.
 */
export function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
}) {
  return (
    <div className={styles.toggle} role="group" aria-label="View">
      {SEGMENTS.map((segment) => (
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
