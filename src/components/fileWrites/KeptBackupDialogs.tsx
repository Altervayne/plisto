// -- Icon Imports --
import { Info } from "lucide-react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- Utils Imports --
import { keptUndoBody } from "../../lib/keptBackupCopy";
import { formatBytes } from "../../lib/format";
import type { KeptAsk } from "../../lib/keptBackups";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { KeptBackup } from "../../types";

// -- Style Imports --
import styles from "./KeptBackupDialogs.module.css";

/**
 * The three confirms of the Kept backups sheet, one open at a time: put an original back, discard one
 * backup, discard every backup that can be reached. `all` is that set, the backups Discard all will delete.
 */
export function KeptBackupDialogs({
  ask,
  all,
  onUndo,
  onDiscard,
  onDiscardAll,
  onClose,
}: {
  ask: KeptAsk | null;
  all: readonly KeptBackup[];
  onUndo: (backup: KeptBackup) => void;
  onDiscard: (backup: KeptBackup) => void;
  onDiscardAll: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const cancel = t((d) => d.fileWrites.cancel);
  const n = all.length;
  const allBytes = formatBytes(all.reduce((sum, b) => sum + b.size, 0));

  return (
    <>
      <ConfirmDialog
        open={ask?.kind === "undo"}
        title={ask?.kind === "undo" ? t((d) => d.fileWrites.kept.undoTitle, { title: ask.backup.title }) : ""}
        prompt={ask?.kind === "undo" ? keptUndoBody(t, ask.backup) : ""}
        confirmLabel={t((d) => d.fileWrites.kept.undoConfirm)}
        cancelLabel={cancel}
        accent
        onConfirm={() => ask?.kind === "undo" && onUndo(ask.backup)}
        onClose={onClose}
      >
        <div className={styles.note}>
          <Info size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>{t((d) => d.fileWrites.kept.undoNote)}</span>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={ask?.kind === "discard"}
        title={ask?.kind === "discard" ? t((d) => d.fileWrites.kept.discardTitle, { title: ask.backup.title }) : ""}
        prompt={
          ask?.kind === "discard"
            ? t((d) => d.fileWrites.kept.discardBody, { size: formatBytes(ask.backup.size), title: ask.backup.title })
            : ""
        }
        confirmLabel={t((d) => d.fileWrites.kept.discardConfirm)}
        cancelLabel={cancel}
        destructive
        onConfirm={() => ask?.kind === "discard" && onDiscard(ask.backup)}
        onClose={onClose}
      />

      <ConfirmDialog
        open={ask?.kind === "all"}
        title={t((d) => d.fileWrites.kept.discardAllTitle, { n })}
        prompt={t((d) => d.fileWrites.kept.discardAllBody, { n, size: allBytes })}
        confirmLabel={t((d) => d.fileWrites.kept.discardAllConfirm, { n })}
        cancelLabel={cancel}
        destructive
        onConfirm={onDiscardAll}
        onClose={onClose}
      />
    </>
  );
}
