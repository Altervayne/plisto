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

/** A box footprint on the grid, as cols x rows. 1x2 and 1x3 are deliberately unauthorized. */
export type BoxSize = "1x1" | "2x1" | "3x1" | "2x2" | "3x2" | "2x3" | "3x3";

/** The footprints a box may take, widths-first so a resize tie breaks toward the wider one. */
const AUTHORIZED: readonly BoxSize[] = ["1x1", "2x1", "3x1", "2x2", "3x2", "2x3", "3x3"];

/** Each size's column and row span, read off the "COLxROW" code so the table cannot drift from the names. */
export const SIZE_SPAN: Record<BoxSize, { cols: number; rows: number }> = Object.fromEntries(
  AUTHORIZED.map((s) => [s, { cols: +s[0], rows: +s[2] }]),
) as Record<BoxSize, { cols: number; rows: number }>;

/** A box's shape family, splitting the picker: a hero count, a cover strip, or a single continuation. */
export type BoxShape = "stat" | "list" | "suggestion";

/** The base landing modes a box seeds. The `both` landing is never stored: it is the union of these two. */
type BaseMode = Exclude<AppMode, "both">;

/** A box's fixed default: its footprint, the sizes a resize may snap to, its shape, and the seeding modes. */
interface BoxSpec {
  size: BoxSize;
  allowedSizes: readonly BoxSize[];
  shape: BoxShape;
  modes: readonly BaseMode[];
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
const LIST_SIZES: readonly BoxSize[] = ["2x1", "3x1", "2x2", "3x2", "2x3", "3x3"];

export const BOX_CATALOG: Record<BoxType, BoxSpec> = {
  missingCovers: { size: "1x1", allowedSizes: ["1x1"], shape: "stat", modes: ["organizer"] },
  unsortedStat: { size: "1x1", allowedSizes: ["1x1"], shape: "stat", modes: ["organizer"] },
  unsortedPreview: { size: "2x1", allowedSizes: LIST_SIZES, shape: "list", modes: ["organizer"] },
  recentlyPlayed: { size: "2x1", allowedSizes: LIST_SIZES, shape: "list", modes: ["player"] },
  mostPlayed: { size: "2x1", allowedSizes: LIST_SIZES, shape: "list", modes: ["player"] },
  missingMetadata: { size: "1x1", allowedSizes: ["1x1"], shape: "stat", modes: ["organizer"] },
  playNext: { size: "2x1", allowedSizes: ["2x1"], shape: "suggestion", modes: ["player"] },
  moreFromArtist: { size: "2x1", allowedSizes: LIST_SIZES, shape: "list", modes: ["player"] },
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

/** Whether a box seeds a landing. The both landing is the union of the base modes, so a box shows there
 *  when it seeds either organizer or player. */
export function boxInMode(type: BoxType, mode: AppMode): boolean {
  const { modes } = BOX_CATALOG[type];
  return mode === "both" ? modes.length > 0 : modes.includes(mode);
}

/** The default layout for a mode: the catalog boxes it seeds, in placement order, at their sizes. */
export function seedLayout(mode: AppMode): BoxSeed[] {
  return BOX_ORDER.filter((type) => boxInMode(type, mode)).map((type) => ({
    type,
    size: BOX_CATALOG[type].size,
  }));
}
