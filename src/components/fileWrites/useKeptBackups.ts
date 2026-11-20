/*
 * The Kept backups sheet's data and actions: the list, and Undo trim, Discard and Discard all over it.
 * Every action re-reads the list afterwards, so a row always shows what the backend holds. A refusal
 * because a file write holds the lock raises the shared busy notice instead of a line of its own.
 */

// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";

// -- State Imports --
import { showFileWriteBusy } from "../../state/fileWrites/store";

// -- IPC Imports --
import { keptBackupDiscard, keptBackupsDiscardAll, keptBackupsList, trimUndo } from "../../lib/ipc";

// -- Utils Imports --
import { busyKind } from "../../lib/busyError";
import { discardAllNotice, discardFailureLine, discardOneNotice, undoFailureLine } from "../../lib/keptBackups";
import { trimFailureOf } from "../../lib/trimReplace";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { KeptBackup } from "../../types";

export function useKeptBackups() {
  const t = useT();
  // null until the first read lands.
  const [backups, setBackups] = useState<KeptBackup[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      keptBackupsList().then(
        (list) => {
          setBackups(list);
          setLoadFailed(false);
        },
        () => setLoadFailed(true),
      ),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  // `work` resolves to the notice to leave, or null.
  const act = async (work: () => Promise<string | null>, failedLine: (error: unknown) => string) => {
    setWorking(true);
    setNotice(null);
    setError(null);
    try {
      setNotice(await work());
    } catch (e) {
      if (busyKind(e) === "fileWrite") showFileWriteBusy();
      else setError(failedLine(e));
    }
    await reload();
    setWorking(false);
  };

  return {
    backups,
    loadFailed,
    working,
    notice,
    error,
    undo: (backup: KeptBackup) =>
      act(
        () => trimUndo(backup.undoId).then(() => null),
        (error) => undoFailureLine(t, trimFailureOf(error), backup),
      ),
    discard: (backup: KeptBackup) =>
      act(
        () => keptBackupDiscard(backup.undoId).then((outcome) => discardOneNotice(t, backup, outcome)),
        (error) => discardFailureLine(t, error),
      ),
    discardAll: () =>
      act(
        () => keptBackupsDiscardAll().then((outcome) => discardAllNotice(t, outcome)),
        () => t((d) => d.fileWrites.kept.discardFailed),
      ),
  };
}
