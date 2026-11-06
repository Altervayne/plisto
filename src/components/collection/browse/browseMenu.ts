/*
 * The focused record's menu as a pure list of entries, gated by the app mode: the play group only
 * while the player is on, Select only while organizing is on. The view maps each id to its label,
 * icon and action.
 */

export type BrowseMenuId = "play" | "next" | "queue" | "playlist" | "open" | "select";

/** A menu row, or null for a separator. */
export type BrowseMenuSlot = BrowseMenuId | null;

export interface BrowseMenuGates {
  player: boolean;
  organize: boolean;
}

/** The menu in order: Play, Play next, Add to queue | Add to playlist | Open in its wall, Select. */
export function browseMenuSlots({ player, organize }: BrowseMenuGates): BrowseMenuSlot[] {
  const slots: BrowseMenuSlot[] = [];
  if (player) slots.push("play", "next", "queue", null);
  slots.push("playlist", null, "open");
  if (organize) slots.push("select");
  return slots;
}
