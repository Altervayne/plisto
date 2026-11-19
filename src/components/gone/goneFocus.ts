/*
 * Keyboard rules of the gone sheet that need no DOM: where Tab lands inside the sheet, and which layer an
 * Escape belongs to.
 */

/** The index Tab should jump to so focus stays in a sheet of `count` focusable items, or null to let it move on. */
export function wrapTab(index: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift && index <= 0) return count - 1;
  if (!shift && index >= count - 1) return 0;
  return null;
}

/** Escape closes the confirm when one is open, and only then the sheet. */
export function escapeTarget(confirmOpen: boolean): "confirm" | "sheet" {
  return confirmOpen ? "confirm" : "sheet";
}
