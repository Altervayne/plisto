// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- State Imports --
import { useRelocateRoot } from "../../state/store";

// -- IPC Imports --
import { previewRelocate } from "../../lib/ipc";
import { pickFolder } from "../../lib/dialog";

// -- Local Imports --
import { IDLE, createLocateFlow } from "../settings/locateFlow";

// -- Type Imports --
import type { LocateFlow, LocateStep } from "../settings/locateFlow";

/**
 * The root Locate flows of the open sheet, one step machine per root and all of them held by the sheet
 * itself. A relocate runs a scan, which swaps the sheet's body for the scan state; keeping the flows here
 * rather than in the blocks lets a step survive that swap and land on its receipt.
 */
export function useGoneLocate() {
  const relocate = useRelocateRoot();
  const [steps, setSteps] = useState<Record<number, LocateStep>>({});
  const flows = useRef(new Map<number, LocateFlow>());

  const flowFor = useCallback(
    (rootId: number): LocateFlow => {
      let flow = flows.current.get(rootId);
      if (!flow) {
        flow = createLocateFlow(rootId, { pickFolder, preview: previewRelocate, relocate }, (step) =>
          setSteps((all) => ({ ...all, [rootId]: step })),
        );
        flows.current.set(rootId, flow);
      }
      return flow;
    },
    [relocate],
  );

  useEffect(() => {
    const held = flows.current;
    return () => held.forEach((flow) => flow.dispose());
  }, []);

  return {
    steps,
    stepOf: (rootId: number): LocateStep => steps[rootId] ?? IDLE,
    /** Opens the folder picker for a root and checks the pick. `name` is the root's folder name now. */
    start: (rootId: number, name: string) => void flowFor(rootId).pick(name),
    /** Re-runs the check for the folder on screen. */
    recheck: (rootId: number) => {
      const step = steps[rootId];
      if (step && "folder" in step) void flowFor(rootId).check(step.name, step.folder);
    },
    confirm: (rootId: number) => void flowFor(rootId).confirm(),
    dismiss: (rootId: number) => flowFor(rootId).cancel(),
  };
}
