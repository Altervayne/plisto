// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PendingWritesConfirm.module.css";

/** How many files the confirm lists before it counts the rest. */
const LISTED = 5;

/**
 * The confirm for removing a folder that still has unfinished writes: it names the files, and says that
 * removing the folder forgets the writes while files still on the drive stay as they are. Open while
 * `files` is set; `files` are absolute paths.
 */
export function PendingWritesConfirm({
  files,
  onConfirm,
  onClose,
}: {
  files: string[] | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const list = files ?? [];
  return (
    <ConfirmDialog
      open={files != null}
      title={t((d) => d.fileWrites.pending.title)}
      prompt={t((d) => d.fileWrites.pending.body)}
      confirmLabel={t((d) => d.fileWrites.pending.confirm)}
      cancelLabel={t((d) => d.fileWrites.cancel)}
      destructive
      width="wide"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <ul className={styles.files}>
        {list.slice(0, LISTED).map((path) => (
          <li key={path} className={styles.file}>
            {path}
          </li>
        ))}
        {list.length > LISTED ? (
          <li className={styles.more}>{t((d) => d.fileWrites.pending.more, { n: list.length - LISTED })}</li>
        ) : null}
      </ul>
      <p className={styles.note}>{t((d) => d.fileWrites.pending.note)}</p>
    </ConfirmDialog>
  );
}
