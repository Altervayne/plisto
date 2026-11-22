// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { RowMessage } from "./useRowActions";

// -- Style Imports --
import styles from "./RowMessageLine.module.css";

/** The line under a plugin list about the last row command, with a way to dismiss it. */
export function RowMessageLine({ message, onDismiss }: { message: RowMessage; onDismiss: () => void }) {
  const t = useT();
  const text =
    message.kind === "dataWarning"
      ? t((d) => d.plugins.dataWarning, { name: message.name })
      : t((d) => d.plugins.actionFailed, {
          name: message.kind === "devFailed" ? t((d) => d.plugins.devMode.label) : message.name,
          message: t((d) => d.plugins.errors[message.error]),
        });
  return (
    <p className={styles.message} role="status">
      <span>{text}</span>
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        {t((d) => d.plugins.sheet.close)}
      </button>
    </p>
  );
}
