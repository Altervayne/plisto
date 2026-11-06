/*
 * How each destination reads in the finder's "Go to" rows: the sidebar's own label and icon, so a jump
 * names a place exactly as the nav does. The Collection's flat segments get rows of their own that land
 * on their segment, so "albums" still finds the album wall. The possible-duplicates sheet rides along as
 * one more place, though it opens over the current view rather than replacing it.
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
  Music,
  Radio,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// -- Type Imports --
import type { Mode, NavTarget } from "../shell/navVisibility";
import type { CollectionSegment } from "../../state/collection/store";

// -- i18n Imports --
import type { Dict } from "../../i18n/en";

/** A Collection segment with its own "Go to" row. Browse has none. */
export type SegmentDestination = Exclude<CollectionSegment, "browse">;

/** A place a "Go to" row reaches: a nav destination, a Collection segment, or the duplicates sheet. */
export type FinderDestination = Mode | SegmentDestination | "duplicates";

const SEGMENT_DESTINATIONS: readonly string[] = ["albums", "singles", "tracks"];

function isSegmentDestination(dest: FinderDestination): dest is SegmentDestination {
  return SEGMENT_DESTINATIONS.includes(dest);
}

/** Where a "Go to" row lands: a segment row names its segment, every other row its destination. */
export function destinationTarget(dest: Exclude<FinderDestination, "duplicates">): NavTarget {
  return isSegmentDestination(dest) ? { segment: dest } : dest;
}

export const DESTINATION_LABEL: Record<FinderDestination, (d: Dict) => string> = {
  home: (d) => d.nav.home,
  files: (d) => d.nav.files,
  unsorted: (d) => d.nav.unsorted,
  covers: (d) => d.nav.covers,
  collection: (d) => d.nav.collection,
  albums: (d) => d.collection.albums,
  singles: (d) => d.collection.singles,
  tracks: (d) => d.collection.tracks,
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
  collection: Library,
  albums: Disc,
  singles: Disc3,
  tracks: Music,
  playlists: ListMusic,
  player: Radio,
  history: History,
  editor: AudioLines,
  export: Download,
  settings: Settings,
  duplicates: Copy,
};
