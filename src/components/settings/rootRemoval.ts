/*
 * What a folder removal came to: done, held back by a running file write or scan, refused for unfinished
 * writes (with the files they name), or failed. Pure over the two calls it makes, so every branch tests
 * without a backend.
 */

// -- Utils Imports --
import { busyKind, isUnfinishedWrites } from "../../lib/busyError";

export type RemovalResult =
  | { kind: "done" }
  | { kind: "fileWrite" }
  | { kind: "scan" }
  | { kind: "unfinished"; files: string[] }
  | { kind: "failed" };

/**
 * Runs `remove`. A refusal for unfinished writes reads the file names through `readPending`; without
 * them the confirm cannot say what it forgets, so a failed read counts as a failed removal. After
 * `dropPendingWrites` a second refusal is a failure, never another confirm.
 */
export async function attemptRemoval(
  remove: () => Promise<void>,
  readPending: () => Promise<string[]>,
  dropPendingWrites: boolean,
): Promise<RemovalResult> {
  try {
    await remove();
    return { kind: "done" };
  } catch (error) {
    const busy = busyKind(error);
    if (busy) return { kind: busy };
    if (dropPendingWrites || !isUnfinishedWrites(error)) return { kind: "failed" };
    return readPending().then(
      (files): RemovalResult => ({ kind: "unfinished", files }),
      (): RemovalResult => ({ kind: "failed" }),
    );
  }
}
