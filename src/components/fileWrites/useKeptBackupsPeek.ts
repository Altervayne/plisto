// -- Framework Imports --
import { useEffect, useState } from "react";

// -- IPC Imports --
import { keptBackupsList } from "../../lib/ipc";

// -- Type Imports --
import type { KeptBackup } from "../../types";

/**
 * The kept backups, read each time `active` turns on, for a confirm that mentions them. A failed read
 * leaves the list empty, so the confirm simply omits its line.
 */
export function useKeptBackupsPeek(active: boolean): KeptBackup[] {
  const [backups, setBackups] = useState<KeptBackup[]>([]);

  useEffect(() => {
    if (!active) {
      setBackups([]);
      return;
    }
    let live = true;
    keptBackupsList().then(
      (list) => live && setBackups(list),
      () => live && setBackups([]),
    );
    return () => {
      live = false;
    };
  }, [active]);

  return backups;
}
