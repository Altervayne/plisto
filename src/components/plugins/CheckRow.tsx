// -- Style Imports --
import styles from "./CheckRow.module.css";

/** A labelled checkbox as one pressable row, used for the "I understand" and "delete saved data" ticks. */
export function CheckRow({
  checked,
  onChange,
  label,
  trailing,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Quiet text at the far end of the row, such as a size. */
  trailing?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={styles.row}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.box} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </button>
  );
}
