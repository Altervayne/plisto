// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { useRemoveRoot } from "../../state/store";
import { showFileWriteBusy } from "../../state/fileWrites/store";
import { useScanIssuesStore } from "../../state/scanIssues";

// -- IPC Imports --
import { pendingWrites } from "../../lib/ipc";

// -- Utils Imports --
import { attemptRemoval } from "./rootRemoval";

/**
 * Removes library folder `rootId`. A refusal for unfinished writes opens the confirm that names the
 * files; confirming it removes the folder again and forgets those writes. Any other failure leaves the
 * folder in place and sets `failed`. A running file write raises the shared busy notice; a scan needs
 * no line, since Remove is disabled while one runs.
 */
export function useRootRemoval(rootId: number) {
  const removeRoot = useRemoveRoot();
  // The files the unfinished-writes confirm names; null while it is closed.
  const [unfinished, setUnfinished] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);

  // A failure line belongs to one folder; another folder starts clean.
  useEffect(() => {
    setFailed(false);
    setUnfinished(null);
  }, [rootId]);

  const run = async (dropPendingWrites: boolean) => {
    setFailed(false);
    const result = await attemptRemoval(
      () => removeRoot(rootId, dropPendingWrites),
      () => pendingWrites(rootId),
      dropPendingWrites,
    );
    if (result.kind === "done") {
      // The removal cascades through the unreadable-file rows of the root.
      void useScanIssuesStore.getState().refreshStanding();
    } else if (result.kind === "fileWrite") {
      showFileWriteBusy();
    } else if (result.kind === "unfinished") {
      setUnfinished(result.files);
    } else if (result.kind === "failed") {
      setUnfinished(null);
      setFailed(true);
    }
  };

  return {
    unfinished,
    failed,
    /** Removes the folder; opens the unfinished-writes confirm when it is refused for them. */
    remove: () => run(false),
    /** Removes the folder and forgets its unfinished writes. */
    removeAnyway: () => run(true),
    dismissUnfinished: () => setUnfinished(null),
  };
}
