// -- Style Imports --
import styles from "./GoneDoorLine.module.css";

/** A quiet warn line stating that files are gone, with a text link into the gone sheet. */
export function GoneDoorLine({
  text,
  action,
  onAction,
}: {
  text: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <span className={styles.line}>
      <span className={styles.text}>{text}</span>
      <button type="button" className={styles.link} onClick={onAction}>
        {action}
      </button>
    </span>
  );
}
