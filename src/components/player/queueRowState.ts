/*
 * Where a queue row stands against the play cursor. The queue is a flat ordered list and the engine's
 * `queue_index` marks the current track, so a row is classified by its own index against that cursor -
 * behind is played, on it is now, ahead is up next. The view paints weight and material from this; the
 * split lives here so it is testable apart from the DOM.
 */

/** A queue row's standing against the play cursor. */
export type QueueRowState = "played" | "now" | "next";

/** Classifies one row's index against the play cursor. */
export function queueRowState(index: number, queueIndex: number): QueueRowState {
  if (index < queueIndex) return "played";
  if (index === queueIndex) return "now";
  return "next";
}

/** How many rows sit ahead of the cursor: the up-next tally the header reads. Never negative. */
export function upNextCount(queueLen: number, queueIndex: number): number {
  return Math.max(0, queueLen - queueIndex - 1);
}
