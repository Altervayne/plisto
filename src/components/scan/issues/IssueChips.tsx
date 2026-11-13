// -- Utils Imports --
import { reasonLabel, standingTotal, visibleChips } from "./issueText";

// -- State Imports --
import type { ReasonCounts } from "../../../state/scanIssues";

// -- Type Imports --
import type { ScanIssueReason } from "../../../types";

// -- i18n Imports --
import { useLocale, useT } from "../../../i18n";

// -- Style Imports --
import styles from "./IssueChips.module.css";

/**
 * The reason filter: an All chip and one chip per reason present, each with its count. With a single
 * reason there is nothing to filter, so the row is absent.
 */
export function IssueChips({
  byReason,
  filter,
  onPick,
}: {
  byReason: ReasonCounts;
  filter: ScanIssueReason | null;
  onPick: (reason: ScanIssueReason | null) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const chips = visibleChips(byReason);
  if (chips.length === 0) return null;

  return (
    <div className={styles.chips}>
      <button
        type="button"
        className={`${styles.chip} ${filter === null ? styles.on : ""}`}
        aria-pressed={filter === null}
        onClick={() => onPick(null)}
      >
        {t((d) => d.scan.issueAll)}
        <span className={styles.count}>{standingTotal(byReason).toLocaleString(locale)}</span>
      </button>
      {chips.map(({ reason, n }) => (
        <button
          key={reason}
          type="button"
          className={`${styles.chip} ${filter === reason ? styles.on : ""}`}
          aria-pressed={filter === reason}
          onClick={() => onPick(reason)}
        >
          {reasonLabel(t, reason)}
          <span className={styles.count}>{n.toLocaleString(locale)}</span>
        </button>
      ))}
    </div>
  );
}
