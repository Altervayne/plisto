// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Style Imports --
import styles from "./HomeBox.module.css";

/**
 * A stat box: a micro-label over a hero count and a one-line verb, the whole region a click to its
 * destination. At zero the count dims and the verb settles to a good-tone all-clear line; a nonzero
 * backlog wears a warn pip before the label while the number stays full ink.
 */
export function StatBox({
  label,
  count,
  verb,
  settled,
  onClick,
}: {
  label: string;
  count: number;
  verb: string;
  settled: string;
  onClick: () => void;
}) {
  const zero = count === 0;

  return (
    <button type="button" className={styles.stat} onClick={onClick}>
      <span className={styles.label}>
        {zero ? null : <span className={styles.pip} aria-hidden="true" />}
        {label}
      </span>
      <span className={styles.num} data-zero={zero ? "" : undefined}>
        {formatCount(count)}
      </span>
      <span className={styles.verb} data-good={zero ? "" : undefined}>
        {zero ? settled : verb}
      </span>
    </button>
  );
}
