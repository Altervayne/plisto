// -- Component Imports --
import { ConfirmDialog } from "../../common/ConfirmDialog/ConfirmDialog";

// -- Utils Imports --
import { failureText } from "./failureText";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { RestoreFailure } from "../../../state/restorePoints/store";

// -- Style Imports --
import styles from "./RestorePoints.module.css";

/** A restore or its dry run that did not go ahead: "Nothing changed", then the reason, and Close. */
export function RestoreFailureSheet({ failure, onClose }: { failure: RestoreFailure; onClose: () => void }) {
  const t = useT();
  return (
    <ConfirmDialog
      open
      hideCancel
      title={t((d) => d.restorePoints.failTitle)}
      prompt={t((d) => d.restorePoints.failPrompt)}
      confirmLabel={t((d) => d.common.close)}
      cancelLabel={t((d) => d.common.cancel)}
      onConfirm={() => {}}
      onClose={onClose}
    >
      <div className={styles.fail}>
        <span className={styles.failTone} aria-hidden="true" />
        <span>{failureText(t, failure)}</span>
      </div>
    </ConfirmDialog>
  );
}
