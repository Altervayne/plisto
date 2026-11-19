/*
 * Reports a startup read that failed, timed out, answered late or recovered to the boot log in the
 * backend. Fire-and-forget: it never throws, never hands back a promise, and keeps no timer, so it cannot
 * slow or fail the read it describes. The log call can fail like any other IPC call; lines then wait in a
 * short in-memory queue and flush in order once a later call goes through, one flush at a time.
 */

// -- IPC Imports --
import { logBootRead } from "./ipc";

export type BootRead = Parameters<typeof logBootRead>[0];
export type BootOutcome = Parameters<typeof logBootRead>[1];

const MAX_QUEUED = 50;
const MAX_ERROR_CHARS = 300;
// Failures and timeouts are logged for the first attempts, then every tenth.
const LEADING_ATTEMPTS = 5;
const THIN_EVERY = 10;

type Line = Parameters<typeof logBootRead>;

const queue: Line[] = [];
let flushing = false;

function worthLogging(outcome: BootOutcome, attempt: number): boolean {
  if (outcome === "late" || outcome === "recovered") return true;
  return attempt <= LEADING_ATTEMPTS || attempt % THIN_EVERY === 0;
}

// Sends the queue front to back. A failed send leaves its line at the front for the next flush.
async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length > 0) {
      await logBootRead(...queue[0]);
      queue.shift();
    }
  } catch {
    // The log path is down too; the lines stay queued.
  } finally {
    flushing = false;
  }
}

/** Queues one line for the boot log and starts a flush. `error` is the rejection, when there is one. */
export function reportBootRead(
  read: BootRead,
  outcome: BootOutcome,
  attempt: number,
  elapsedMs: number,
  error?: unknown,
): void {
  try {
    if (!worthLogging(outcome, attempt)) return;
    // Beyond the cap the newest lines are dropped: the oldest ones show where the trouble began.
    if (queue.length < MAX_QUEUED) {
      const text = error === undefined ? null : String(error).slice(0, MAX_ERROR_CHARS);
      queue.push([read, outcome, attempt, Math.round(elapsedMs), text]);
    }
    void flush();
  } catch {
    // Reporting never fails a read.
  }
}
