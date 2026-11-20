// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- State Imports --
import { useCancelScan, useFolderLocating, useLocateFolder, useRelocateRoot } from "../../state/store";

// -- IPC Imports --
import { previewLocateFolder, previewRelocate } from "../../lib/ipc";
import { pickFolder } from "../../lib/dialog";

// -- Local Imports --
import { folderName } from "../settings/locateCopy";
import { IDLE, createLocateFlow, createLocateFolderFlow } from "../settings/locateFlow";

// -- Type Imports --
import type { GoneGroup } from "../../state/gone/goneGroups";
import type { LocateFlow, LocateStep } from "../settings/locateFlow";

/** What a folder flow needs of a group: its folded id, its root and its real-case path. */
export type FolderTarget = Pick<GoneGroup, "id" | "path"> & { rootId: number };

/**
 * The Locate flows of the open sheet, one step machine per root and one per gone folder, all held by the
 * sheet itself. A relocate runs a scan, which swaps the sheet's body for the scan state, and a folder
 * locate reloads the library so its group leaves the list; keeping the flows here rather than in the rows
 * lets a step survive either and land on its receipt. Once any apply lands, a folder preview still awaiting
 * its confirm is checked again, since the apply may have changed what it counted.
 */
export function useGoneLocate() {
  const relocate = useRelocateRoot();
  const locateFolder = useLocateFolder();
  const cancelScan = useCancelScan();
  const locating = useFolderLocating();
  const [folderSteps, setFolderSteps] = useState<Record<string, LocateStep>>({});
  const folderFlows = useRef(new Map<string, LocateFlow>());
  // The latest step of each folder flow, read outside a render when an apply lands.
  const latest = useRef(new Map<string, LocateStep>());

  const recheckWaiting = useCallback((except?: string) => {
    for (const [id, step] of latest.current) {
      if (id !== except && step.kind === "confirm") void folderFlows.current.get(id)?.check(step.name, step.folder);
    }
  }, []);
  const [steps, setSteps] = useState<Record<number, LocateStep>>({});
  const flows = useRef(new Map<number, LocateFlow>());

  const flowFor = useCallback(
    (rootId: number): LocateFlow => {
      let flow = flows.current.get(rootId);
      if (!flow) {
        flow = createLocateFlow(rootId, { pickFolder, preview: previewRelocate, relocate }, (step) => {
          setSteps((all) => ({ ...all, [rootId]: step }));
          if (step.kind === "done") recheckWaiting();
        });
        flows.current.set(rootId, flow);
      }
      return flow;
    },
    [relocate, recheckWaiting],
  );

  const folderFlowFor = useCallback(
    (target: FolderTarget): LocateFlow => {
      let flow = folderFlows.current.get(target.id);
      if (!flow) {
        flow = createLocateFolderFlow(
          target.rootId,
          target.path,
          { pickFolder, preview: previewLocateFolder, locate: locateFolder, stop: () => void cancelScan() },
          (step) => {
            latest.current.set(target.id, step);
            setFolderSteps((all) => ({ ...all, [target.id]: step }));
            if (step.kind === "done") recheckWaiting(target.id);
          },
        );
        folderFlows.current.set(target.id, flow);
      }
      return flow;
    },
    [locateFolder, cancelScan, recheckWaiting],
  );

  useEffect(() => {
    const held = [flows.current, folderFlows.current];
    return () => held.forEach((all) => all.forEach((flow) => flow.dispose()));
  }, []);

  return {
    folderSteps,
    /**
     * A folder apply is in flight, here or from a sheet closed since: it holds the scan lock, so every other
     * Locate and Remove waits.
     */
    folderRunning: locating || Object.values(folderSteps).some((step) => step.kind === "running"),
    /** Opens the folder picker for a gone folder and checks the pick. */
    startFolder: (target: FolderTarget) => void folderFlowFor(target).pick(folderName(target.path)),
    // A step only exists once its flow does, so the rest act on the flow held under the group id.
    recheckFolder: (id: string) => {
      const step = folderSteps[id];
      if (step && "folder" in step) void folderFlows.current.get(id)?.check(step.name, step.folder);
    },
    confirmFolder: (id: string) => void folderFlows.current.get(id)?.confirm(),
    dismissFolder: (id: string) => folderFlows.current.get(id)?.cancel(),
    stopFolder: (id: string) => folderFlows.current.get(id)?.stop(),
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
