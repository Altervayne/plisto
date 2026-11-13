// -- Style Imports --
import styles from "./Switch.module.css";

/**
 * The pill switch: cyan when on, sunken and quiet when off. A bare control with no row around it; the
 * caller lays out the label beside it. `label` is the accessible name. A disabled switch is dimmed and
 * ignores the press. A pending switch keeps its knob where it is, dims, and ignores the press while
 * staying focusable and announced as busy; it marks a change the caller has asked for and not yet seen.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  pending = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  pending?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      aria-busy={pending ? "true" : undefined}
      className={pending ? `${styles.switch} ${styles.pending}` : styles.switch}
      onClick={() => {
        if (!pending) onChange(!checked);
      }}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}
