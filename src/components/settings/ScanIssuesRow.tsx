// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Type Imports --
import type { IssuesStatus } from "../../state/scanIssues";

// -- i18n Imports --
import { useLocale, useT } from "../../i18n";

// -- Style Imports --
import styles from "./SettingsView.module.css";
import rowStyles from "./ScanIssuesRow.module.css";

/** What the row shows: hidden for a real zero and for the first read in flight, an error line when the read failed. */
export function issuesRowState(count: number | null, status: IssuesStatus): "hidden" | "count" | "error" {
  if (status === "error") return "error";
  return (count ?? 0) > 0 ? "count" : "hidden";
}

/**
 * The standing unreadable-files row under the scan summary: the label, the count, and a Review button
 * opening the sheet. It reads the count on record, so it survives restarts and quiet rescans. A failed
 * read shows a quiet line and a Retry rather than a count, so a failure never reads as zero.
 */
export function ScanIssuesRow({
  count,
  status,
  onReview,
  onRetry,
}: {
  count: number | null;
  status: IssuesStatus;
  onReview: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const state = issuesRowState(count, status);
  if (state === "hidden") return null;
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{t((d) => d.scan.issuesTitle)}</span>
      <span className={`${styles.control} ${styles.controlQuiet} ${rowStyles.trail}`}>
        {state === "error" ? (
          <>
            <span className={rowStyles.count}>{t((d) => d.scan.issueCountError)}</span>
            <QuietButton onClick={onRetry}>{t((d) => d.scan.issueRetry)}</QuietButton>
          </>
        ) : (
          <>
            <span className={`${rowStyles.count} tabular`}>{(count ?? 0).toLocaleString(locale)}</span>
            <QuietButton onClick={onReview}>{t((d) => d.scan.issueReview)}</QuietButton>
          </>
        )}
      </span>
    </div>
  );
}
