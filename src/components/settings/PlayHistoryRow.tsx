// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- IPC Imports --
import { resetPlayHistory } from "../../lib/ipc";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SettingsView.module.css";
import rowStyles from "./PlayHistoryRow.module.css";

/**
 * The Playback row that wipes the whole play log. The button opens a destructive confirm; the result
 * reads on a line under the row, a done note or a warn-tone failure. The backend emits the change event,
 * so History and the Home boxes refresh without any call from here.
 */
export function PlayHistoryRow() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<"done" | "failed" | null>(null);

  const onConfirm = () => {
    setResult(null);
    resetPlayHistory().then(
      () => setResult("done"),
      () => setResult("failed"),
    );
  };

  return (
    <div className={styles.pref}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>{t((d) => d.settings.playHistory)}</span>
        <span className={`${styles.control} ${styles.controlQuiet}`}>
          <QuietButton destructive onClick={() => setConfirming(true)}>
            {t((d) => d.settings.playHistoryReset)}
          </QuietButton>
        </span>
      </div>
      <p className={styles.helper}>{t((d) => d.settings.playHistoryHelper)}</p>
      {result === "done" ? (
        <p className={styles.helper} role="status">
          {t((d) => d.settings.playHistoryDone)}
        </p>
      ) : null}
      {result === "failed" ? (
        <p className={rowStyles.failed} role="alert">
          {t((d) => d.settings.playHistoryFailed)}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={t((d) => d.settings.playHistoryConfirmTitle)}
        prompt={t((d) => d.settings.playHistoryConfirmPrompt)}
        confirmLabel={t((d) => d.settings.playHistoryConfirmAction)}
        cancelLabel={t((d) => d.common.cancel)}
        onConfirm={onConfirm}
        onClose={() => setConfirming(false)}
        destructive
      />
    </div>
  );
}
