/*
 * Which index Browse focuses when the focused album's id may have left the order. A present id keeps
 * its record wherever it re-sorted to; a missing one (deleted, merged away, or filtered out) lands on
 * whichever record now sits at its old index, clamped to the ends, so the shelf never snaps to the start.
 */

/**
 * The focus index in an order of `count` records. `offsetOf` answers the id's index or null,
 * `previous` is the index the shelf last rested on (null when it has not rested yet: a fresh mount).
 */
export function resolveFocus(
  offsetOf: (id: number) => number | null,
  count: number,
  focusId: number | null,
  previous: number | null,
): number {
  if (count === 0) return 0;
  const found = focusId === null ? null : offsetOf(focusId);
  if (found !== null) return Math.min(count - 1, found);
  return Math.max(0, Math.min(count - 1, previous ?? 0));
}
