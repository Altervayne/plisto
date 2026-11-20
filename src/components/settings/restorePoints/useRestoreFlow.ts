// -- Framework Imports --
import { useCallback, useState } from "react";

// -- State Imports --
import { useRestorePointsStore } from "../../../state/restorePoints/store";
import type { RestoreFailure } from "../../../state/restorePoints/store";

// -- Type Imports --
import type { RestorePointRow, RestoreSummary } from "../../../types";

/** The sheet that asks before a restore: the point and what its dry run found. */
export interface PendingRestore {
  row: RestorePointRow;
  summary: RestoreSummary;
}

/**
 * The steps from a row's Restore button to a running restore: the dry run, the sheet it fills, the
 * confirm, and which point is being restored. The outcome lives in the restore store.
 */
export function useRestoreFlow() {
  const plan = useRestorePointsStore((s) => s.plan);
  const restore = useRestorePointsStore((s) => s.restore);
  const [planning, setPlanning] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const [planFailure, setPlanFailure] = useState<RestoreFailure | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const start = useCallback(
    async (row: RestorePointRow) => {
      setPlanning(row.file);
      const result = await plan(row.file);
      setPlanning(null);
      if (result.kind === "ready") setPending({ row, summary: result.summary });
      else setPlanFailure(result.failure);
    },
    [plan],
  );

  const run = useCallback(
    (file: string) => {
      setRestoring(file);
      void restore(file);
    },
    [restore],
  );

  return {
    planning,
    pending,
    planFailure,
    restoring,
    start,
    run,
    cancel: useCallback(() => setPending(null), []),
    dismissPlanFailure: useCallback(() => setPlanFailure(null), []),
  };
}
