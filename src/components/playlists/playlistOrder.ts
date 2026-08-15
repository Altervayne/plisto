/*
 * The playlist slot-order math: a pure reorder over slot ids. A drop takes the over-slot's place and
 * lands before or after it by the DIRECTION of travel - a slot dragged downward (it started above the
 * over) lands after it, one dragged upward lands before it. Direction is what dnd-kit's arrayMove keys
 * on, and it stays correct both ways where a mid-drag pointer-vs-row read drifts by one on an upward
 * move. Framework-free and deterministic, so the list and its test share one ordering.
 */

/**
 * Moves `movedId` to the slot `overId` holds and returns the whole new order. A no-op (same slot, or
 * either id absent) returns the input order unchanged.
 */
export function reorderSlots(ids: number[], movedId: number, overId: number): number[] {
  const from = ids.indexOf(movedId);
  const over = ids.indexOf(overId);
  if (from === -1 || over === -1 || from === over) return ids;

  const rest = ids.filter((id) => id !== movedId);
  // Downward (the moved slot sat above the over) lands after it; upward lands before it.
  const at = rest.indexOf(overId) + (from < over ? 1 : 0);
  rest.splice(at, 0, movedId);
  return rest;
}
