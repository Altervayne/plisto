// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { PluginErrorKey } from "../../state/plugins/errors";

// -- Style Imports --
import styles from "../settings/plugins/RowMessageLine.module.css";

/** The hub's failed-action line, for a restart that was refused. */
export function RestartFailure({ error, onDismiss }: { error: PluginErrorKey; onDismiss: () => void }) {
  const t = useT();
  return (
    <p className={styles.message} role="status">
      <span>
        {t((d) => d.plugins.actionFailed, {
          name: t((d) => d.plugins.safeEntry.label),
          message: t((d) => d.plugins.errors[error]),
        })}
      </span>
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        {t((d) => d.plugins.sheet.close)}
      </button>
    </p>
  );
}
