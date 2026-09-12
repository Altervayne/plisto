/*
 * The Home bento's box catalog: the pure table of which boxes exist, their default size, and which app
 * modes seed them onto the landing. Framework-free so the grid and the tests read one source. The app
 * mode only chooses the default set; the grid places whatever the seed hands it. Adding a box is one
 * entry here plus its component in the registry - the grid never changes.
 */

// -- Type Imports --
import type { AppMode } from "../../state/player/store";

/** Every box the landing can show. */
export type BoxType =
  | "missingCovers"
  | "unsortedStat"
  | "unsortedPreview"
  | "recentlyPlayed"
  | "mostPlayed";

/** A box footprint on the grid: S 1x1, M 2x1 (wide), T 1x2 (tall), L 2x2. */
export type BoxSize = "S" | "M" | "T" | "L";

/** A box's fixed default: its footprint, the sizes a resize may snap to, and the modes that seed it. */
interface BoxSpec {
  size: BoxSize;
  allowedSizes: readonly BoxSize[];
  modes: readonly AppMode[];
}

/** The placed box order, walked to build a mode's default seed. */
export const BOX_ORDER: readonly BoxType[] = [
  "missingCovers",
  "unsortedStat",
  "unsortedPreview",
  "recentlyPlayed",
  "mostPlayed",
];

/** Each box's size, resize range, and mode membership. The single point H3 extends to add a box type. */
export const BOX_CATALOG: Record<BoxType, BoxSpec> = {
  missingCovers: { size: "S", allowedSizes: ["S", "M"], modes: ["organizer", "both"] },
  unsortedStat: { size: "S", allowedSizes: ["S", "M"], modes: ["organizer", "both"] },
  unsortedPreview: { size: "M", allowedSizes: ["M", "L"], modes: ["organizer"] },
  recentlyPlayed: { size: "M", allowedSizes: ["M", "L"], modes: ["player", "both"] },
  mostPlayed: { size: "M", allowedSizes: ["M", "L"], modes: ["player", "both"] },
};

/** A box's shape family, split for the picker. A stat carries the single-cell S size; a list never does. */
export function boxShape(type: BoxType): "stat" | "list" {
  return BOX_CATALOG[type].allowedSizes.includes("S") ? "stat" : "list";
}

/** A placed box: its type and the footprint it occupies. */
export interface BoxSeed {
  type: BoxType;
  size: BoxSize;
}

/** The default layout for a mode: the catalog boxes it seeds, in placement order, at their sizes. */
export function seedLayout(mode: AppMode): BoxSeed[] {
  return BOX_ORDER.filter((type) => BOX_CATALOG[type].modes.includes(mode)).map((type) => ({
    type,
    size: BOX_CATALOG[type].size,
  }));
}

/** A size's column and row span on the bento grid. */
export const SIZE_SPAN: Record<BoxSize, { cols: number; rows: number }> = {
  S: { cols: 1, rows: 1 },
  M: { cols: 2, rows: 1 },
  T: { cols: 1, rows: 2 },
  L: { cols: 2, rows: 2 },
};
