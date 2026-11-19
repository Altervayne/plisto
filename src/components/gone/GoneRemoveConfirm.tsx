// -- Icon Imports --
import { History } from "lucide-react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./GoneRemoveConfirm.module.css";

/**
 * The confirm before gone tracks leave the library. It names the count, says the files stay and that the
 * removal cannot be undone, and notes the restore point saved first. Open while `count` is set.
 */
export function GoneRemoveConfirm({
  count,
  onConfirm,
  onClose,
}: {
  count: number | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const n = count ?? 0;
  return (
    <ConfirmDialog
      open={count != null}
      title={t((d) => d.gone.removeTitle, { n })}
      prompt={t((d) => d.gone.removeBody)}
      confirmLabel={t((d) => d.gone.removeButton, { n })}
      cancelLabel={t((d) => d.common.cancel)}
      destructive
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <div className={styles.point}>
        <History size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>{t((d) => d.gone.restorePoint)}</span>
      </div>
    </ConfirmDialog>
  );
}
