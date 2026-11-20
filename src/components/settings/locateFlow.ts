/*
 * The step machine behind a Locate action: pick a folder, check it, confirm, apply. One machine serves a
 * whole root (relocate) and a gone subfolder of a root (locate folder); each builder binds its target into
 * closures, so the steps and the panel that draws them are shared. Kept free of React and the store so
 * each transition is tested with injected dependencies. Every operation takes a ticket; a newer operation,
 * or a dispose, makes an older response stale and drops it, so a slow check never lands on a flow the user
 * has moved past.
 */

// -- Type Imports --
import type { LocateFolderPreview, LocateFolderRefusal, RelocatePreview, RelocateRefusal } from "../../types";
import type { LocateFolderResult, RelocateResult } from "../../state/relocate";
import type { BusyKind } from "../../lib/busyError";

/** A refusal from the backend, or the busy guard when a scan or a file write already holds the lock. */
export type LocateRefusal = RelocateRefusal | LocateFolderRefusal | { code: "busy"; by?: BusyKind };

/** A folder locate's ready preview: how many gone tracks relink, take in a scanned twin, or stay gone. */
export type FolderPlan = Omit<Extract<LocateFolderPreview, { kind: "ready" }>, "kind"> & { kind: "folder" };

/**
 * A preview the user can act on: moving the root to the folder, merging an indexed root into it, or
 * pointing a gone subfolder's tracks at it.
 */
export type LocatePlan = Extract<RelocatePreview, { kind: "move" | "merge" }> | FolderPlan;

/**
 * Where the flow stands. `name` is the root's folder name when the flow began, kept because the root's
 * own path (and so its name) changes once the relocate lands; `folder` is the full path picked.
 */
export type LocateStep =
  | { kind: "idle" }
  | { kind: "checking"; name: string; folder: string }
  | { kind: "confirm"; name: string; folder: string; plan: LocatePlan }
  | { kind: "running"; name: string; folder: string }
  | { kind: "done"; name: string; folder: string; missing: number; located?: number }
  | { kind: "refused"; name: string; folder: string; reason: LocateRefusal };

export const IDLE: LocateStep = { kind: "idle" };

/** The calls a root flow makes, injected so a test can stand in for the folder picker and the backend. */
export interface LocateDeps {
  pickFolder: () => Promise<string | null>;
  preview: (rootId: number, folder: string) => Promise<RelocatePreview>;
  relocate: (rootId: number, folder: string) => Promise<RelocateResult>;
}

/** The calls a folder flow makes. `stop` asks a running apply to end early; the apply still reports how it ended. */
export interface LocateFolderDeps {
  pickFolder: () => Promise<string | null>;
  preview: (rootId: number, folder: string, newPath: string) => Promise<LocateFolderPreview>;
  locate: (rootId: number, folder: string, newPath: string) => Promise<LocateFolderResult>;
  stop?: () => void;
}

/** The target-bound calls the step machine runs on; the builders below close over the root or folder. */
interface TargetDeps {
  pickFolder: () => Promise<string | null>;
  preview: (picked: string) => Promise<LocatePlan | { kind: "refused"; reason: LocateRefusal }>;
  /** Carries out the plan and returns the step it leaves. */
  apply: (name: string, picked: string) => Promise<LocateStep>;
  stop?: () => void;
}

export interface LocateFlow {
  /** Opens the folder picker, then checks the pick. A cancelled picker changes nothing. */
  pick: (name: string) => Promise<void>;
  /** Checks a known folder: a retry, or the merge hint's target. */
  check: (name: string, folder: string) => Promise<void>;
  /** Carries out the plan on screen. Only a confirm step acts. */
  confirm: () => Promise<void>;
  /** Drops the flow back to idle and discards any response still in flight. */
  cancel: () => void;
  /** Asks a running apply to end early, where the target supports it. The step stays until the apply reports. */
  stop: () => void;
  /** Discards any response still in flight without touching the step. */
  dispose: () => void;
}

/** The step a finished relocate leaves. A failed rescan leaves the flow, since the gate shows its error. */
export function stepAfterRelocate(name: string, folder: string, result: RelocateResult): LocateStep {
  switch (result.kind) {
    case "done":
      return { kind: "done", name, folder, missing: result.summary.missing };
    case "refused":
      return { kind: "refused", name, folder, reason: result.reason };
    case "busy":
      return { kind: "refused", name, folder, reason: { code: "busy", by: result.by } };
    case "failed":
      return IDLE;
  }
}

/** The step a finished folder locate leaves. */
export function stepAfterLocateFolder(name: string, folder: string, result: LocateFolderResult): LocateStep {
  switch (result.kind) {
    case "done":
      return { kind: "done", name, folder, missing: result.stays, located: result.relinked + result.merged };
    case "refused":
      return { kind: "refused", name, folder, reason: result.reason };
    case "busy":
      return { kind: "refused", name, folder, reason: { code: "busy", by: result.by } };
    case "failed":
      return { kind: "refused", name, folder, reason: { code: "failed", message: result.message } };
  }
}

/** Builds the flow for one root. `emit` receives every step the flow moves to. */
export function createLocateFlow(
  rootId: number,
  deps: LocateDeps,
  emit: (step: LocateStep) => void,
): LocateFlow {
  return createTargetFlow(
    {
      pickFolder: deps.pickFolder,
      preview: (picked) => deps.preview(rootId, picked),
      apply: async (name, picked) => stepAfterRelocate(name, picked, await deps.relocate(rootId, picked)),
    },
    emit,
  );
}

/** Builds the flow for the gone tracks under `folder` of a root. */
export function createLocateFolderFlow(
  rootId: number,
  folder: string,
  deps: LocateFolderDeps,
  emit: (step: LocateStep) => void,
): LocateFlow {
  return createTargetFlow(
    {
      pickFolder: deps.pickFolder,
      preview: async (picked) => {
        const preview = await deps.preview(rootId, folder, picked);
        if (preview.kind === "refused") return preview;
        const { kind: _ready, ...rest } = preview;
        return { kind: "folder", ...rest };
      },
      apply: async (name, picked) => stepAfterLocateFolder(name, picked, await deps.locate(rootId, folder, picked)),
      stop: deps.stop,
    },
    emit,
  );
}

function createTargetFlow(deps: TargetDeps, emit: (step: LocateStep) => void): LocateFlow {
  let ticket = 0;
  let current: LocateStep = IDLE;

  const go = (step: LocateStep) => {
    current = step;
    emit(step);
  };

  const checkFolder = async (mine: number, name: string, folder: string) => {
    go({ kind: "checking", name, folder });
    let preview: Awaited<ReturnType<TargetDeps["preview"]>>;
    try {
      preview = await deps.preview(folder);
    } catch (e) {
      if (mine !== ticket) return;
      go({ kind: "refused", name, folder, reason: { code: "failed", message: String(e) } });
      return;
    }
    if (mine !== ticket) return;
    if (preview.kind === "refused") {
      go({ kind: "refused", name, folder, reason: preview.reason });
      return;
    }
    go({ kind: "confirm", name, folder, plan: preview });
  };

  return {
    pick: async (name) => {
      const mine = ++ticket;
      const folder = await deps.pickFolder();
      if (mine !== ticket || !folder) return;
      await checkFolder(mine, name, folder);
    },

    check: async (name, folder) => {
      await checkFolder(++ticket, name, folder);
    },

    confirm: async () => {
      if (current.kind !== "confirm") return;
      const { name, folder } = current;
      const mine = ++ticket;
      go({ kind: "running", name, folder });
      const step = await deps.apply(name, folder);
      if (mine !== ticket) return;
      go(step);
    },

    cancel: () => {
      ticket += 1;
      go(IDLE);
    },

    stop: () => {
      if (current.kind === "running") deps.stop?.();
    },

    dispose: () => {
      ticket += 1;
    },
  };
}
