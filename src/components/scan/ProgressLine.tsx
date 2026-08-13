// -- Style Imports --
import styles from "./ProgressLine.module.css";

/**
 * The progress bar. Pass `value` (0..1) for a determinate fill; pass null for the indeterminate
 * sweep used while the file total is still unknown.
 */
export function ProgressLine({ value }: { value: number | null }) {
  const determinate = value !== null;
  const pct = Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100);

  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? pct : undefined}
    >
      {determinate ? (
        <div className={styles.fill} style={{ width: `${pct}%` }} />
      ) : (
        <div className={styles.indeterminate} />
      )}
    </div>
  );
}
