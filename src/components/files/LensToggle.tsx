// -- Style Imports --
import styles from "./LensToggle.module.css";

/** How the files view reads the scope: the folder hierarchy or a flat list of every file under it. */
export type Lens = "folders" | "all-files";

/** The two segments, in display order. */
const SEGMENTS: { value: Lens; label: string }[] = [
  { value: "folders", label: "Folders" },
  { value: "all-files", label: "All files" },
];

/**
 * A segmented Folders/All-files control: a soft recess holding two chips, the active one raised. The
 * accent is deliberately absent - the raised chip alone marks the choice, leaving the sidebar's Files
 * nav as the one accent for this view.
 */
export function LensToggle({
  value,
  onChange,
}: {
  value: Lens;
  onChange: (value: Lens) => void;
}) {
  return (
    <div className={styles.toggle} role="group" aria-label="File view">
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
