// -- State Imports --
import { useDuplicateCounts } from "../../state/duplicates/store";
import { useOpenDuplicates } from "../../state/shell/store";

// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FacetFilter.module.css";

/**
 * The filter menu's "Possible duplicates..." row with its set count. It opens the review sheet rather
 * than narrowing the grid, and hides while there is nothing to review.
 */
export function DuplicatesFilterRow({ onPick }: { onPick: () => void }) {
  const t = useT();
  const { sets } = useDuplicateCounts();
  const openDuplicates = useOpenDuplicates();

  if (sets === 0) return null;

  return (
    <li>
      <button
        type="button"
        role="menuitem"
        className={styles.row}
        onClick={() => {
          onPick();
          openDuplicates();
        }}
      >
        <span className={styles.rowLabel}>{t((d) => d.duplicates.menuItem)}</span>
        <span className={`${styles.rowIcon} tabular`}>{formatCount(sets)}</span>
      </button>
    </li>
  );
}
