// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { SpliceItem, SpliceReport } from "../../types";

// -- Style Imports --
import styles from "./SpliceRunReport.module.css";

// How many skipped or failed rows the collapsed list shows before folding the rest into a tally.
const LIST_CAP = 10;

/**
 * The done report under the title: the error and skip counts, each only when non-zero, over a short
 * collapsed list of the failed and skipped segments with their notes. Failed rows lead - they want
 * action - then skipped. Accent-free by design; the good dot above carries the done signal.
 */
export function SpliceRunReport({ report }: { report: SpliceReport }) {
  const t = useT();

  const failed = report.items.filter((i) => i.status === "failed");
  const skipped = report.items.filter((i) => i.status === "skipped");
  const flagged: SpliceItem[] = [...failed, ...skipped];
  const shown = flagged.slice(0, LIST_CAP);
  const overflow = flagged.length - shown.length;

  return (
    <div className={styles.report}>
      {report.errors > 0 ? (
        <span className={styles.errors}>{t((d) => d.export.errors, { n: report.errors })}</span>
      ) : null}
      {skipped.length > 0 ? (
        <span className={styles.skipped}>{t((d) => d.export.skipped, { n: skipped.length })}</span>
      ) : null}
      {shown.length > 0 ? (
        <div className={styles.items}>
          {shown.map((item) => (
            <span key={item.index} className={styles.item}>
              <span className={styles.container}>
                {t((d) => d.splice.segmentLabel, { n: item.index + 1 })}
              </span>
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
