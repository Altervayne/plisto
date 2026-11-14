/*
 * Where a queue row stands against the play cursor. The queue is a flat ordered list and the engine's
 * `queue_index` marks the current track, so a row is classified by its own index against that cursor -
 * behind is played, on it is now, ahead is up next. The view paints weight and material from this; the
 * split lives here so it is testable apart from the DOM.
 */

/**
 * A queue row's standing against the play cursor. `parked` is the cursor row while a plugin stream holds
 * the seat: the track is paused under the stream, so nothing marks it as playing.
 */
export type QueueRowState = "played" | "now" | "next" | "parked";

/**
 * Classifies one row's index against the play cursor. `stream` is set while a plugin stream holds the
 * seat: the cursor row is then `parked` when a track is parked under it, and plain `next` when none is
 * (nothing is paused, so nothing marks the row).
 */
export function queueRowState(
  index: number,
  queueIndex: number,
  stream: { parked: boolean } | null = null,
): QueueRowState {
  if (index < queueIndex) return "played";
  if (index === queueIndex) {
    if (!stream) return "now";
    return stream.parked ? "parked" : "next";
  }
  return "next";
}

/** How many rows sit ahead of the cursor: the up-next tally the header reads. Never negative. */
export function upNextCount(queueLen: number, queueIndex: number): number {
  return Math.max(0, queueLen - queueIndex - 1);
}

/**
 * Resolves a queue drag into the move to apply, or null for a no-op. Only up-next rows move, and a drop
 * is clamped to just past the cursor so it can never land in played or now territory. A drop that would
 * not shift the row (outside any target, onto itself, or already at the clamped slot) returns null.
 */
export function resolveQueueReorder(
  from: number,
  to: number,
  queueIndex: number,
): { from: number; to: number } | null {
  if (from < 0 || to < 0) return null;
  if (from <= queueIndex) return null;
  const target = Math.max(to, queueIndex + 1);
  if (target === from) return null;
  return { from, to: target };
}
