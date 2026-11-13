/*
 * The hub's review flow as a hook: one flow controller for the life of the section, its sheet read as
 * external state. The flow itself lives in `state/plugins/reviewFlow.ts`.
 */

// -- Framework Imports --
import { useEffect, useMemo, useSyncExternalStore } from "react";

// -- State Imports --
import { createReviewFlow } from "../../../state/plugins/reviewFlow";

// -- Type Imports --
import type { OperationLock } from "../../../state/plugins/operationLock";
import type { ReviewFlow } from "../../../state/plugins/reviewFlow";
import type { SheetState } from "../../../state/plugins/sheet";

export function useReviewFlow(lock: OperationLock): ReviewFlow & { sheet: SheetState | null } {
  const flow = useMemo(() => createReviewFlow(lock), [lock]);

  useEffect(() => {
    flow.activate();
    return () => flow.dispose();
  }, [flow]);

  const sheet = useSyncExternalStore(flow.subscribe, flow.getSheet);
  return { ...flow, sheet };
}
