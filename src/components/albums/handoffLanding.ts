/*
 * Decides what the album wall does with a pending hand-off. Pure, so the rules (wrong wall, hidden by a
 * filter, Player mode) are pinned apart from the grid that acts on the answer.
 */

// -- Type Imports --
import type { CollectionHandoff } from "../../state/collection/store";

/** What the wall does with the hand-off: wait for it, clear the date filter first, or land it. */
export type Landing =
  | { kind: "ignore" }
  | { kind: "clear-filter" }
  | { kind: "land"; albumId: number; how: "open" | "select" };

/**
 * The wall's move for a hand-off. A target this wall does not hold is ignored, so the other wall can
 * take it. A target the date filter hides asks for the filter to clear first. Select needs the organize
 * controls; in Player mode it lands as a plain open.
 */
export function planLanding(
  handoff: CollectionHandoff | null,
  wallIds: ReadonlySet<number>,
  visibleIds: ReadonlySet<number>,
  organize: boolean,
): Landing {
  if (!handoff || !wallIds.has(handoff.albumId)) return { kind: "ignore" };
  if (!visibleIds.has(handoff.albumId)) return { kind: "clear-filter" };
  const how = handoff.how === "select" && organize ? "select" : "open";
  return { kind: "land", albumId: handoff.albumId, how };
}
