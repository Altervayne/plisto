// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./LensToggle.module.css";

/** How the files view reads the scope: the folder hierarchy or a flat list of every file under it. */
export type Lens = "folders" | "all-files";

/** The two segments, in display order. */
const SEGMENTS: Lens[] = ["folders", "all-files"];

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
  const t = useT();

  return (
    <div className={styles.toggle} role="group" aria-label={t((d) => d.files.fileView)}>
      {SEGMENTS.map((segment) => (
        <button
          key={segment}
          type="button"
          className={`${styles.segment} ${value === segment ? styles.active : ""}`}
          aria-pressed={value === segment}
          onClick={() => onChange(segment)}
        >
          {segment === "folders" ? t((d) => d.files.folders) : t((d) => d.files.allFiles)}
        </button>
      ))}
    </div>
  );
}
