/*
 * The step machine behind a folder row's Locate action: pick a folder, check it, confirm, relocate.
 * Kept free of React and the store so each transition is tested with injected dependencies. Every
 * operation takes a ticket; a newer operation, or a dispose, makes an older response stale and drops it,
 * so a slow check never lands on a flow the user has moved past.
 */

// -- Type Imports --
import type { RelocatePreview, RelocateRefusal } from "../../types";
import type { RelocateResult } from "../../state/relocate";

/** A refusal from the backend, or the busy guard when a scan already holds the lock. */
export type LocateRefusal = RelocateRefusal | { code: "busy" };

/** A preview the user can act on: moving the root to the folder, or merging an indexed root into it. */
export type LocatePlan = Extract<RelocatePreview, { kind: "move" | "merge" }>;

/**
 * Where the flow stands. `name` is the root's folder name when the flow began, kept because the root's
 * own path (and so its name) changes once the relocate lands; `folder` is the full path picked.
 */
export type LocateStep =
  | { kind: "idle" }
  | { kind: "checking"; name: string; folder: string }
  | { kind: "confirm"; name: string; folder: string; plan: LocatePlan }
  | { kind: "running"; name: string; folder: string }
  | { kind: "done"; name: string; folder: string; missing: number }
  | { kind: "refused"; name: string; folder: string; reason: LocateRefusal };

export const IDLE: LocateStep = { kind: "idle" };

/** The calls the flow makes, injected so a test can stand in for the folder picker and the backend. */
export interface LocateDeps {
  pickFolder: () => Promise<string | null>;
  preview: (rootId: number, folder: string) => Promise<RelocatePreview>;
  relocate: (rootId: number, folder: string) => Promise<RelocateResult>;
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
      return { kind: "refused", name, folder, reason: { code: "busy" } };
    case "failed":
      return IDLE;
  }
}

/** Builds the flow for one root. `emit` receives every step the flow moves to. */
export function createLocateFlow(
  rootId: number,
  deps: LocateDeps,
  emit: (step: LocateStep) => void,
): LocateFlow {
  let ticket = 0;
  let current: LocateStep = IDLE;

  const go = (step: LocateStep) => {
    current = step;
    emit(step);
  };

  const checkFolder = async (mine: number, name: string, folder: string) => {
    go({ kind: "checking", name, folder });
    let preview: RelocatePreview;
    try {
      preview = await deps.preview(rootId, folder);
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
      const result = await deps.relocate(rootId, folder);
      if (mine !== ticket) return;
      go(stepAfterRelocate(name, folder, result));
    },

    cancel: () => {
      ticket += 1;
      go(IDLE);
    },

    dispose: () => {
      ticket += 1;
    },
  };
}
