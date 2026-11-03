// -- Framework Imports --
import { useEffect, useMemo, useState } from "react";

// -- State Imports --
import { useRelocateRoot } from "../../state/store";

// -- IPC Imports --
import { previewRelocate } from "../../lib/ipc";
import { pickFolder } from "../../lib/dialog";

// -- Local Imports --
import { IDLE, createLocateFlow } from "./locateFlow";

// -- Type Imports --
import type { LocateStep } from "./locateFlow";

/**
 * Drives one folder row's Locate flow: the current step and the actions that move it. `name` is the
 * row's folder name at the moment an action runs. The flow outlives the root's own path change, so the
 * receipt still names the folder as it was.
 */
export function useLocateFlow(rootId: number, name: string) {
  const relocate = useRelocateRoot();
  const [step, setStep] = useState<LocateStep>(IDLE);

  const flow = useMemo(
    () => createLocateFlow(rootId, { pickFolder, preview: previewRelocate, relocate }, setStep),
    [rootId, relocate],
  );
  useEffect(() => () => flow.dispose(), [flow]);

  return {
    step,
    /** Opens the picker and checks the folder chosen. */
    start: () => void flow.pick(name),
    /** Checks a folder already known, such as the merge hint's target. */
    checkFolder: (folder: string) => void flow.check(name, folder),
    /** Re-runs the check for the folder on screen. */
    recheck: () => {
      if ("folder" in step) void flow.check(step.name, step.folder);
    },
    confirm: () => void flow.confirm(),
    dismiss: () => flow.cancel(),
  };
}
