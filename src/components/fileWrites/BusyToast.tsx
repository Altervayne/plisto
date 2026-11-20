// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { Toast } from "../common/Toast/Toast";

// -- State Imports --
import { useFileWritesBusyAt, useFileWritesStore } from "../../state/fileWrites/store";
import { TOAST_VISIBLE_MS } from "../../state/plugins/uiQueue";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./BusyToast.module.css";

/** The pill shown when an action was refused because a write to the music files holds the lock. */
export function BusyToast() {
  const t = useT();
  const busyAt = useFileWritesBusyAt();
  const dismiss = useFileWritesStore((s) => s.dismissBusy);

  useEffect(() => {
    if (busyAt == null) return;
    const timer = setTimeout(dismiss, TOAST_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [busyAt, dismiss]);

  return (
    <Toast visible={busyAt != null} className={styles.pill}>
      <span className={styles.text}>{t((d) => d.fileWrites.busy)}</span>
    </Toast>
  );
}
