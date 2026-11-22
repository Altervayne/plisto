/*
 * What the feed recorder is doing, readable from anywhere: the kind recording, since when, whether it is
 * saving, and the last outcome until it fades. The recorder is a singleton that outlives any chip showing
 * it, so a chip that mounts mid-recording or after the save reads this instead of starting idle.
 */

// -- Type Imports --
import type { RecordRefusal } from "./recordFeed";

/** How long an outcome stays before it clears. */
export const RESULT_MS = 5000;

export type FeedOutcome =
  { ok: true; path: string } | { ok: false; reason: RecordRefusal; detail: string | null };

export interface FeedRecording {
  // The kind of the running or last recording; null before any.
  kind: string | null;
  phase: "idle" | "recording" | "saving";
  // Epoch milliseconds the recording began.
  startedAt: number;
  outcome: FeedOutcome | null;
}

export const NO_RECORDING: FeedRecording = { kind: null, phase: "idle", startedAt: 0, outcome: null };

let current = NO_RECORDING;
const listeners = new Set<() => void>();
let fade: ReturnType<typeof setTimeout> | undefined;

/** The current state; the same object until something changes. */
export const feedRecording = (): FeedRecording => current;

/** Calls `notify` on every change until the returned release runs. */
export function subscribeFeedRecording(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Replaces the state; an outcome set here clears itself after RESULT_MS. */
export function publishFeedRecording(next: FeedRecording): void {
  clearTimeout(fade);
  current = next;
  if (next.outcome) {
    fade = setTimeout(() => publishFeedRecording({ ...next, outcome: null }), RESULT_MS);
  }
  listeners.forEach((notify) => notify());
}
