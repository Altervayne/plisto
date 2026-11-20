// -- Type Imports --
import type { StampScope } from "../types";

/** The scope a "Write tags" menu item opens the sheet on, with the ids it covers. */
export interface MenuStampTarget {
  trackIds: number[];
  scope: StampScope;
}

/**
 * What a row's "Write tags" menu item covers. A right-click on a selected row acts on the whole
 * selection; on any other row it acts on that row alone. `order` fixes the id order when the caller has
 * a visual one; a selected id it does not list follows in selection order.
 */
export function menuStampTarget(
  rowId: number,
  selection: ReadonlySet<number>,
  order?: readonly number[],
): MenuStampTarget {
  let trackIds: number[];
  if (selection.has(rowId)) {
    const ordered = order ? order.filter((id) => selection.has(id)) : [];
    const seen = new Set(ordered);
    trackIds = [...ordered, ...[...selection].filter((id) => !seen.has(id))];
  } else {
    trackIds = [rowId];
  }
  return { trackIds, scope: { kind: "tracks", trackIds } };
}

/** The scope over whole albums. */
export function albumsStampScope(albumIds: number[]): StampScope {
  return { kind: "albums", albumIds };
}
