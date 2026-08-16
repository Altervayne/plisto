// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CoverFilter.module.css";

/** Which folders the triage shows: only those still lacking art, or every discovered folder. */
export type CoverScope = "needs" | "all";

/** The two segments, in display order. */
const SEGMENTS: CoverScope[] = ["needs", "all"];

/**
 * The Needs cover / All segmented control: a soft recess holding two chips, the active one raised. No
 * accent - the raised chip alone marks the choice, leaving the sidebar's Covers nav as the view's one
 * accent, the same way the files lens toggle reads.
 */
export function CoverFilter({
  value,
  onChange,
}: {
  value: CoverScope;
  onChange: (value: CoverScope) => void;
}) {
  const t = useT();

  return (
    <div className={styles.toggle} role="group" aria-label={t((d) => d.covers.filterLabel)}>
      {SEGMENTS.map((segment) => (
        <button
          key={segment}
          type="button"
          className={`${styles.segment} ${value === segment ? styles.active : ""}`}
          aria-pressed={value === segment}
          onClick={() => onChange(segment)}
        >
          {segment === "needs" ? t((d) => d.covers.filterNeeds) : t((d) => d.covers.filterAll)}
        </button>
      ))}
    </div>
  );
}
