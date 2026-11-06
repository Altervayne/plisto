/*
 * Browse focus movement: single steps and group jumps. Each takes the order's shape and the current
 * focus and returns the next focus index, always inside the order.
 */

/** The part of a Browse order the movement reads. */
export interface BrowseShape {
  count: number;
  groups: { start: number }[];
  groupOf: ArrayLike<number>;
}

/** Records moved by a page jump when nothing is grouped. */
export const PAGE_STEP = 10;

const clamp = (i: number, count: number): number => Math.max(0, Math.min(count - 1, i));

/** Moves `step` records, stopping at either end. An empty order stays at 0. */
export function stepFocus(shape: BrowseShape, focus: number, step: number): number {
  return shape.count === 0 ? 0 : clamp(focus + step, shape.count);
}

/**
 * Page Down goes to the next group's start (the last record from the final group). Page Up goes to
 * this group's start, or the previous group's when already on it. Ungrouped, both move a page.
 */
export function jumpGroup(shape: BrowseShape, focus: number, dir: 1 | -1): number {
  if (shape.count === 0) return 0;
  if (shape.groups.length === 0) return clamp(focus + PAGE_STEP * dir, shape.count);
  const g = shape.groupOf[focus];
  if (dir > 0) return g + 1 < shape.groups.length ? shape.groups[g + 1].start : shape.count - 1;
  const start = shape.groups[g].start;
  return focus > start ? start : shape.groups[Math.max(0, g - 1)].start;
}
