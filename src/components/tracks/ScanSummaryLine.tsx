// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Type Imports --
import type { ScanSummary } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ScanSummaryLine.module.css";

/**
 * The quiet, persistent line describing the last scan: how many landed and what changed. Only the parts
 * that carry a number show, so a clean run reads short. When the scan left files gone from disk it appends
 * a gone-count, and `onReview` arms an inline Review link that opens the gone-filtered view. Not a toast,
 * not a banner.
 */
export function ScanSummaryLine({
  summary,
  onReview,
}: {
  summary: ScanSummary;
  onReview?: () => void;
}) {
  const t = useT();
  const parts: string[] = [`${formatCount(summary.total)} indexed`];

  // On a first scan everything is new, so folding it in would only echo the indexed count.
  if (summary.inserted > 0 && summary.inserted !== summary.total) {
    parts.push(`${formatCount(summary.inserted)} new`);
  }
  if (summary.updated > 0) parts.push(`${formatCount(summary.updated)} changed`);
  if (summary.removed > 0) parts.push(`${formatCount(summary.removed)} removed`);
  if (summary.errors > 0) parts.push(`${formatCount(summary.errors)} unreadable`);
  if (summary.cancelled) parts.push("cancelled");

  return (
    <p className={`${styles.line} tabular`}>
      {parts.join(" - ")}
      {summary.missing > 0 ? (
        <>
          {" - "}
          {t((d) => d.tracks.goneSummary, { n: summary.missing })}
          {onReview ? (
            <>
              {" "}
              <button type="button" className={styles.review} onClick={onReview}>
                {t((d) => d.tracks.reviewGone)}
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </p>
  );
}
