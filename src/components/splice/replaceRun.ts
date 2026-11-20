/*
 * The order of one replace or undo, apart from React so it tests with fakes: recheck the block, stop
 * the preview, honor a Cancel that came in meanwhile, then call the back end and read its answer.
 */

// -- Utils Imports --
import { isCancelledRejection, trimFailureOf } from "../../lib/trimReplace";
import type { TrimFailureInfo } from "../../lib/trimReplace";
import type { TrimFailure } from "../../types";

/** How a run ended. `blocked` and `cancelled` never touched the file; `blocked` says why. */
export type RunOutcome<T> =
  | { kind: "blocked"; why: TrimFailure }
  | { kind: "cancelled" }
  | { kind: "done"; result: T }
  | { kind: "failed"; failure: TrimFailureInfo };

/** What a run reads and calls. `blocked` and `cancelAsked` read live state at each step. */
export interface RunSteps<T> {
  /** Whether another write is in flight; read once, before this one is held. */
  busy: () => boolean;
  /** Why the write may not run now, as the back end would refuse it, or null. */
  blocked: () => TrimFailure | null;
  stopPreview: () => Promise<void>;
  cancelAsked: () => boolean;
  call: () => Promise<T>;
}

/**
 * Runs one write. Another write in flight, a block, or a Cancel seen before the call means the back end
 * is never asked; once asked, only the explicit cancelled rejection is a clean cancel, and anything else
 * is a failure.
 */
export async function runWrite<T>(steps: RunSteps<T>): Promise<RunOutcome<T>> {
  if (steps.busy()) return { kind: "blocked", why: "busy" };
  const early = steps.blocked();
  if (early) return { kind: "blocked", why: early };
  await steps.stopPreview().catch(() => {});
  if (steps.cancelAsked()) return { kind: "cancelled" };
  const late = steps.blocked();
  if (late) return { kind: "blocked", why: late };
  try {
    return { kind: "done", result: await steps.call() };
  } catch (error) {
    if (isCancelledRejection(error)) return { kind: "cancelled" };
    return { kind: "failed", failure: trimFailureOf(error) };
  }
}
