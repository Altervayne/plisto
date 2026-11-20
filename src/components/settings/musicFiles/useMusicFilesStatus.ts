/*
 * What the Music files section reads from the backend: the last write, the library-wide differ count and
 * the kept backups. Each read fails quiet: a rejection leaves its value null so the section hides that
 * line instead of showing a wrong one, and the command answers again on the next refresh.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { useFileWritesSheet, useFileWritesStore } from "../../../state/fileWrites/store";

// -- IPC Imports --
import { keptBackupsList, lastFileWrite, stampDifferCount } from "../../../lib/ipc";

// -- Type Imports --
import type { KeptBackup, LastFileWrite } from "../../../types";

/** `undefined` while a read is in flight, `null` when it failed or found nothing. */
export interface MusicFilesStatus {
  last: LastFileWrite | undefined;
  differ: number | null | undefined;
  kept: KeptBackup[] | null | undefined;
}

/**
 * Reads the status lines of the section. `wantDiffer` and `wantKept` skip a read whose line is not on
 * screen. The reads repeat when a batch ends or a sheet closes, since either can change the numbers.
 */
export function useMusicFilesStatus(wantDiffer: boolean, wantKept: boolean): MusicFilesStatus {
  // A boolean, so a file event of a running batch does not re-render the section.
  const idle = useFileWritesStore((state) => state.running === null);
  const sheet = useFileWritesSheet();
  const refresh = `${idle}:${sheet === null}`;
  const [last, setLast] = useState<LastFileWrite | undefined>(undefined);
  const [differ, setDiffer] = useState<number | null | undefined>(undefined);
  const [kept, setKept] = useState<KeptBackup[] | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    lastFileWrite().then(
      (v) => live && setLast(v),
      () => live && setLast(null),
    );
    return () => {
      live = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!wantDiffer) return;
    let live = true;
    stampDifferCount({ kind: "library" }).then(
      (v) => live && setDiffer(v.files),
      () => live && setDiffer(null),
    );
    return () => {
      live = false;
    };
  }, [wantDiffer, refresh]);

  useEffect(() => {
    if (!wantKept) return;
    let live = true;
    keptBackupsList().then(
      (v) => live && setKept(v),
      () => live && setKept(null),
    );
    return () => {
      live = false;
    };
  }, [wantKept, refresh]);

  return { last, differ, kept };
}
