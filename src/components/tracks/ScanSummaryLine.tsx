// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Type Imports --
import type { ScanSummary } from "../../types";

// -- Style Imports --
import styles from "./ScanSummaryLine.module.css";

/**
 * The quiet, persistent line describing the last scan: how many landed and what changed. Only the
 * parts that carry a number show, so a clean run reads short. Not a toast, not a banner.
 */
export function ScanSummaryLine({ summary }: { summary: ScanSummary }) {
  const parts: string[] = [`${formatCount(summary.total)} indexed`];

  // On a first scan everything is new, so folding it in would only echo the indexed count.
  if (summary.inserted > 0 && summary.inserted !== summary.total) {
    parts.push(`${formatCount(summary.inserted)} new`);
  }
  if (summary.updated > 0) parts.push(`${formatCount(summary.updated)} changed`);
  if (summary.removed > 0) parts.push(`${formatCount(summary.removed)} removed`);
  if (summary.errors > 0) parts.push(`${formatCount(summary.errors)} unreadable`);
  if (summary.cancelled) parts.push("cancelled");

  return <p className={`${styles.line} tabular`}>{parts.join(" - ")}</p>;
}
