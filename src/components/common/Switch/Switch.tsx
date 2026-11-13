// -- Style Imports --
import styles from "./Switch.module.css";

/**
 * The pill switch: cyan when on, sunken and quiet when off. A bare control with no row around it; the
 * caller lays out the label beside it. `label` is the accessible name. A disabled switch is dimmed and
 * ignores the press.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={styles.switch}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}
