/*
 * The icons a plugin's nav item can name: one explicit map from the manifest's lucide names to the
 * components, so no icon is ever resolved by string at runtime and the bundle holds only these. The names
 * match the allow-list in the Rust manifest check; a name outside it, or none, falls back to a neutral dot.
 */

// -- Icon Imports --
import {
  Activity,
  Album,
  Archive,
  AudioLines,
  AudioWaveform,
  Bell,
  Bookmark,
  ChartBar,
  CircleHelp,
  Clock,
  Cloud,
  Cog,
  Compass,
  Database,
  Disc3,
  Dot,
  Download,
  Drum,
  FileText,
  Folder,
  Gauge,
  Globe,
  Guitar,
  Headphones,
  Heart,
  House,
  Info,
  LayoutGrid,
  Library,
  ListMusic,
  Mic,
  Music,
  Music2,
  Puzzle,
  Radio,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tag,
  Timer,
  WandSparkles,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const PLUGIN_NAV_ICONS: Readonly<Record<string, LucideIcon>> = {
  activity: Activity,
  album: Album,
  archive: Archive,
  "audio-lines": AudioLines,
  "audio-waveform": AudioWaveform,
  bell: Bell,
  bookmark: Bookmark,
  "chart-bar": ChartBar,
  "circle-help": CircleHelp,
  clock: Clock,
  cloud: Cloud,
  cog: Cog,
  compass: Compass,
  database: Database,
  "disc-3": Disc3,
  download: Download,
  drum: Drum,
  "file-text": FileText,
  folder: Folder,
  gauge: Gauge,
  globe: Globe,
  guitar: Guitar,
  headphones: Headphones,
  heart: Heart,
  house: House,
  info: Info,
  "layout-grid": LayoutGrid,
  library: Library,
  "list-music": ListMusic,
  mic: Mic,
  music: Music,
  "music-2": Music2,
  puzzle: Puzzle,
  radio: Radio,
  "sliders-horizontal": SlidersHorizontal,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  timer: Timer,
  "wand-sparkles": WandSparkles,
  zap: Zap,
};

/** The icon for items that name none, or one outside the map. */
export const NEUTRAL_ICON: LucideIcon = Dot;

/** The component for a manifest icon name. An own-property lookup, so a name like "constructor" misses. */
export function navIconFor(name: string | null): LucideIcon {
  if (name == null || !Object.prototype.hasOwnProperty.call(PLUGIN_NAV_ICONS, name)) return NEUTRAL_ICON;
  return PLUGIN_NAV_ICONS[name];
}
