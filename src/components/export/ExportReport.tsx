// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { ExportItem, ExportSummary } from "../../types";

// -- Style Imports --
import styles from "./ExportView.module.css";

// How many skipped or failed rows the collapsed list shows before folding the rest into a tally.
const LIST_CAP = 10;

/**
 * The persistent done report: the exported count, then skip and error counts only when non-zero, over
 * a short collapsed list of the skipped and failed containers with their notes. The full per-file
 * table is a later concern; this is the scannable fix-and-rerun summary. Accent-free by design.
 */
export function ExportReport({ summary }: { summary: ExportSummary }) {
  const t = useT();

  // Failed rows lead the list (they need action), then skipped (informational).
  const failed = summary.items.filter((i) => i.status === "failed");
  const skipped = summary.items.filter((i) => i.status === "skipped");
  const flagged: ExportItem[] = [...failed, ...skipped];
  const shown = flagged.slice(0, LIST_CAP);
  const overflow = flagged.length - shown.length;

  return (
    <div className={styles.report}>
      <span className={styles.written}>{t((d) => d.export.written, { n: summary.exported })}</span>
      {summary.skipped > 0 ? (
        <span className={styles.skipped}>{t((d) => d.export.skipped, { n: summary.skipped })}</span>
      ) : null}
      {summary.errors > 0 ? (
        <span className={styles.errors}>{t((d) => d.export.errors, { n: summary.errors })}</span>
      ) : null}
      {shown.length > 0 ? (
        <div className={styles.items}>
          {shown.map((item) => (
            <span key={`${item.track_id}-${item.container}`} className={styles.item}>
              <span className={styles.container}>{item.container}</span>
              {item.note ? <span className={styles.note}> - {item.note}</span> : null}
            </span>
          ))}
          {overflow > 0 ? (
            <span className={styles.more}>{t((d) => d.export.more, { n: overflow })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
