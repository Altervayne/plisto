// -- Icon Imports --
import { Info, ShieldCheck } from "lucide-react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- Type Imports --
import type { ReplaceSnapshot } from "./useTrimReplaceFlow";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrimReplaceDialogs.module.css";

/** The hidden backup's name as the confirm can know it: the op id is only drawn when the run starts. */
const BACKUP_PREFIX = ".plisto-tmp-bak-...-";

/**
 * The confirm before replacing: what changes, where the original is kept and for how long, the sync and
 * undo notes, and the restore point saved first.
 */
export function TrimReplaceConfirm({
  open,
  name,
  snapshot,
  keep,
  onConfirm,
  onClose,
}: {
  open: boolean;
  name: string;
  snapshot: ReplaceSnapshot | null;
  keep: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <ConfirmDialog
      open={open && snapshot != null}
      title={t((d) => d.fileWrites.trim.confirmTitle, { name })}
      prompt=""
      confirmLabel={t((d) => d.fileWrites.trim.confirmButton)}
      cancelLabel={t((d) => d.fileWrites.cancel)}
      onConfirm={onConfirm}
      onClose={onClose}
      width="wide"
      accent
    >
      {snapshot ? (
        <ul className={styles.list}>
          <li>{t((d) => d.fileWrites.trim.confirmAudio, { from: snapshot.from, to: snapshot.to })}</li>
          <li>
            {t((d) => d.fileWrites.trim.confirmBackup, { size: snapshot.size, keep })}
            <br />
            <span className={styles.hidden}>{`${BACKUP_PREFIX}${name}`}</span>
          </li>
          <li>{t((d) => d.fileWrites.trim.confirmSync)}</li>
          <li>{t((d) => d.fileWrites.trim.confirmUndo)}</li>
        </ul>
      ) : null}
      <div className={styles.note}>
        <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>{t((d) => d.fileWrites.trim.confirmPoint)}</span>
      </div>
    </ConfirmDialog>
  );
}

/** The confirm before putting the original back, refused by the backend if the file changed since. */
export function TrimUndoConfirm({
  open,
  name,
  snapshot,
  onConfirm,
  onClose,
}: {
  open: boolean;
  name: string;
  snapshot: ReplaceSnapshot | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <ConfirmDialog
      open={open && snapshot != null}
      title={t((d) => d.fileWrites.trim.undoTitle, { name })}
      prompt={snapshot ? t((d) => d.fileWrites.trim.undoBody, { to: snapshot.to, from: snapshot.from }) : ""}
      confirmLabel={t((d) => d.fileWrites.trim.undoConfirm)}
      cancelLabel={t((d) => d.fileWrites.cancel)}
      onConfirm={onConfirm}
      onClose={onClose}
      accent
    >
      <div className={styles.note}>
        <Info size={15} strokeWidth={1.8} aria-hidden="true" />
        <span>{t((d) => d.fileWrites.trim.undoNote)}</span>
      </div>
    </ConfirmDialog>
  );
}
