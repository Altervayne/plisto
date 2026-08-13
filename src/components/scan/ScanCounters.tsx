// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Style Imports --
import styles from "./ScanCounters.module.css";

/**
 * Live counts for a running scan: how many files are read, out of the total once it is known,
 * plus a read-error tally when any file's tags could not be parsed.
 */
export function ScanCounters({
  scanned,
  total,
  errors,
}: {
  scanned: number;
  total: number;
  errors: number;
}) {
  return (
    <div className={`${styles.counters} tabular`}>
      <span>
        {total > 0 ? `${formatCount(scanned)} / ${formatCount(total)}` : formatCount(scanned)}
      </span>
      {errors > 0 ? (
        <span className={styles.errors}>{formatCount(errors)} unreadable</span>
      ) : null}
    </div>
  );
}
