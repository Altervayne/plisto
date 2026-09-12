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
  | "mostPlayed"
  | "missingMetadata"
  | "playNext"
  | "moreFromArtist";

/** A box footprint on the grid: S 1x1, M 2x1 (wide), T 1x2 (tall), L 2x2. */
export type BoxSize = "S" | "M" | "T" | "L";

/** A box's shape family, splitting the picker: a hero count, a cover strip, or a single continuation. */
export type BoxShape = "stat" | "list" | "suggestion";

/** A box's fixed default: its footprint, the sizes a resize may snap to, its shape, and the seeding modes. */
interface BoxSpec {
  size: BoxSize;
  allowedSizes: readonly BoxSize[];
  shape: BoxShape;
  modes: readonly AppMode[];
}

/** The placed box order, walked to build a mode's default seed. */
export const BOX_ORDER: readonly BoxType[] = [
  "missingCovers",
  "unsortedStat",
  "unsortedPreview",
  "recentlyPlayed",
  "mostPlayed",
  "missingMetadata",
  "playNext",
  "moreFromArtist",
];

/** Each box's size, resize range, shape, and mode membership. The single point to extend to add a box. */
export const BOX_CATALOG: Record<BoxType, BoxSpec> = {
  missingCovers: { size: "S", allowedSizes: ["S", "M"], shape: "stat", modes: ["organizer", "both"] },
  unsortedStat: { size: "S", allowedSizes: ["S", "M"], shape: "stat", modes: ["organizer", "both"] },
  unsortedPreview: { size: "M", allowedSizes: ["M", "L"], shape: "list", modes: ["organizer"] },
  recentlyPlayed: { size: "M", allowedSizes: ["M", "L"], shape: "list", modes: ["player", "both"] },
  mostPlayed: { size: "M", allowedSizes: ["M", "L"], shape: "list", modes: ["player", "both"] },
  missingMetadata: { size: "S", allowedSizes: ["S", "M"], shape: "stat", modes: ["organizer", "both"] },
  playNext: { size: "T", allowedSizes: ["T"], shape: "suggestion", modes: ["player", "both"] },
  moreFromArtist: { size: "M", allowedSizes: ["M", "L"], shape: "list", modes: ["player", "both"] },
};

/** A box's shape family, split for the picker. */
export function boxShape(type: BoxType): BoxShape {
  return BOX_CATALOG[type].shape;
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
