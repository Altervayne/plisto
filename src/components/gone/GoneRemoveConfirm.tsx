// -- Icon Imports --
import { Archive, History } from "lucide-react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./GoneRemoveConfirm.module.css";

/**
 * The confirm before gone tracks leave the library. It names the count, says the files stay and that the
 * removal cannot be undone, and notes the restore point saved first. Open while `count` is set. `backups`
 * is how many of those tracks have a kept backup, which stays in Kept backups.
 */
export function GoneRemoveConfirm({
  count,
  backups = 0,
  onConfirm,
  onClose,
}: {
  count: number | null;
  backups?: number;
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
      {backups > 0 ? (
        <div className={styles.point}>
          <Archive size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>{t((d) => d.fileWrites.purge.backups, { n: backups })}</span>
        </div>
      ) : null}
      <div className={styles.point}>
        <History size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>{t((d) => d.gone.restorePoint)}</span>
      </div>
    </ConfirmDialog>
  );
}
