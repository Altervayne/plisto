/*
 * How each destination reads in the finder's "Go to" rows: the sidebar's own label and icon, so a jump
 * names a place exactly as the nav does. The possible-duplicates sheet rides along as one more place,
 * though it opens over the current view rather than replacing it.
 */

// -- Icon Imports --
import {
  AudioLines,
  Copy,
  Disc,
  Disc3,
  Download,
  History,
  Home,
  Images,
  Inbox,
  LayoutGrid,
  Library,
  ListMusic,
  Radio,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// -- Type Imports --
import type { Mode } from "../shell/navVisibility";

// -- i18n Imports --
import type { Dict } from "../../i18n/en";

/** A place a "Go to" row reaches: a nav destination, or the possible-duplicates sheet. */
export type FinderDestination = Mode | "duplicates";

export const DESTINATION_LABEL: Record<FinderDestination, (d: Dict) => string> = {
  home: (d) => d.nav.home,
  files: (d) => d.nav.files,
  unsorted: (d) => d.nav.unsorted,
  covers: (d) => d.nav.covers,
  tracks: (d) => d.nav.tracks,
  albums: (d) => d.nav.albums,
  singles: (d) => d.nav.singles,
  playlists: (d) => d.playlists.nav,
  player: (d) => d.nav.player,
  history: (d) => d.nav.history,
  editor: (d) => d.nav.editor,
  export: (d) => d.nav.export,
  settings: (d) => d.settings.nav,
  duplicates: (d) => d.duplicates.title,
};

export const DESTINATION_ICON: Record<FinderDestination, LucideIcon> = {
  home: Home,
  files: LayoutGrid,
  unsorted: Inbox,
  covers: Images,
  tracks: Library,
  albums: Disc,
  singles: Disc3,
  playlists: ListMusic,
  player: Radio,
  history: History,
  editor: AudioLines,
  export: Download,
  settings: Settings,
  duplicates: Copy,
};
