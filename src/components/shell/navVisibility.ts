/*
 * The nav visibility rules for the app mode. The mode is the app's working identity - Player, Organizer,
 * or Both - and it shapes which sidebar destinations and section labels show. Both shows everything;
 * Player drops the file and utility surfaces; Organizer drops the all-tracks list and the player.
 *
 * The Mode type lives here rather than in the Sidebar so the sidebar and the shell can both read the
 * rules without importing each other. Settings sits in the foot, outside the sections, so no mode ever
 * hides it.
 */

// -- Type Imports --
import type { AppMode } from "../../state/player/store";

/** The region showing in the main pane: the landing, a library wall, the export screen, or settings. */
export type Mode =
  | "home"
  | "files"
  | "tracks"
  | "unsorted"
  | "albums"
  | "singles"
  | "playlists"
  | "covers"
  | "editor"
  | "player"
  | "history"
  | "export"
  | "settings";

/** The three labeled sidebar sections, each holding its destinations in nav order. */
export const NAV_SECTIONS = {
  files: ["files", "unsorted", "covers"],
  library: ["tracks", "albums", "singles", "playlists", "player", "history"],
  utilities: ["editor", "export"],
} as const satisfies Record<string, readonly Mode[]>;

/** Every browse destination in nav order, the sections laid end to end. Settings stays out: it is foot. */
const NAV_ORDER: readonly Mode[] = [
  ...NAV_SECTIONS.files,
  ...NAV_SECTIONS.library,
  ...NAV_SECTIONS.utilities,
];

/** The destinations each mode hides from the nav. Settings is never listed, so it always shows. */
const HIDDEN: Record<AppMode, ReadonlySet<Mode>> = {
  both: new Set(),
  player: new Set(["files", "unsorted", "covers", "editor", "export"]),
  organizer: new Set(["tracks", "player", "history"]),
};

/** Whether a destination's nav row shows under the mode. Home is the landing for every mode, outside
 * the three sections, so it shows regardless of what a mode hides. */
export function isDestinationVisible(appMode: AppMode, dest: Mode): boolean {
  if (dest === "home") return true;
  return !HIDDEN[appMode].has(dest);
}

/** Whether a section shows at all: true once any of its destinations is visible, so an all-hidden
 * section drops its label with its rows. */
export function isSectionVisible(appMode: AppMode, section: readonly Mode[]): boolean {
  return section.some((dest) => isDestinationVisible(appMode, dest));
}

/** The first still-visible destination in nav order, the landing when a mode flip hides the current one. */
export function firstVisibleDestination(appMode: AppMode): Mode {
  return NAV_ORDER.find((dest) => isDestinationVisible(appMode, dest)) ?? "settings";
}
