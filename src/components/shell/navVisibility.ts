/*
 * The nav visibility rules for the app mode. The mode is the app's working identity - Player, Organizer,
 * or Both - and it shapes which sidebar destinations and section labels show. Both shows everything;
 * Player drops the file and utility surfaces; Organizer drops the player and its listening history.
 * The Collection stays in every mode - it is the library view for browsing and for organizing alike.
 *
 * The Mode type lives here rather than in the Sidebar so the sidebar and the shell can both read the
 * rules without importing each other. Settings sits in the foot, outside the sections, so no mode ever
 * hides it.
 */

// -- Type Imports --
import type { AppMode } from "../../state/player/store";
import type { CollectionTarget } from "../../state/collection/store";
import type {
  PluginListing,
  PluginManifestSummary,
  PluginMode,
  PluginRow,
  PluginSidebarItem,
} from "../../types";

/**
 * The region showing in the main pane: the landing, a library view, the export screen, settings, or an
 * enabled plugin's page (`plugin:<id>`).
 */
export type Mode =
  | "home"
  | "files"
  | "unsorted"
  | "collection"
  | "playlists"
  | "covers"
  | "editor"
  | "player"
  | "history"
  | "export"
  | "settings"
  | `plugin:${string}`;

/** A destination that is not a plugin page. */
export type BuiltInMode = Exclude<Mode, `plugin:${string}`>;

/**
 * Where a navigation lands: a destination as it stands, or a Collection segment named explicitly. A bare
 * "collection" opens the remembered segment; a target overrides it and becomes the remembered one.
 */
export type NavTarget = Mode | CollectionTarget;

/** The three labeled sidebar sections, each holding its destinations in nav order. */
export const NAV_SECTIONS = {
  files: ["files", "unsorted", "covers"],
  library: ["collection", "playlists", "player", "history"],
  utilities: ["editor", "export"],
} as const satisfies Record<string, readonly Mode[]>;

/** Every browse destination in nav order, the sections laid end to end. Settings stays out: it is foot. */
export const NAV_ORDER: readonly Mode[] = [
  ...NAV_SECTIONS.files,
  ...NAV_SECTIONS.library,
  ...NAV_SECTIONS.utilities,
];

/** The destinations each mode hides from the nav. Settings is never listed, so it always shows. */
const HIDDEN: Record<AppMode, ReadonlySet<Mode>> = {
  both: new Set(),
  player: new Set(["files", "unsorted", "covers", "editor", "export"]),
  organizer: new Set(["player", "history"]),
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

// -- Plugin zone --

/** The destination of a plugin's page. */
export function pluginMode(id: string): Mode {
  return `plugin:${id}`;
}

/** The plugin id behind a plugin destination, or null for any other destination. */
export function pluginIdOf(mode: Mode): string | null {
  return mode.startsWith("plugin:") ? mode.slice("plugin:".length) : null;
}

/** Whether a plugin declaring these modes shows under the app mode. Both shows every plugin. */
export function isPluginVisible(appMode: AppMode, modes: readonly PluginMode[]): boolean {
  return appMode === "both" || modes.includes(appMode);
}

/** A registry row that can be drawn: its manifest is readable. */
export type ZonePlugin = PluginRow & { manifest: PluginManifestSummary };

/**
 * The plugins that are live, in install order: ready, enabled and a readable manifest. The base of every
 * "is this plugin running" question; the app mode only filters it further.
 */
export function livePlugins(rows: readonly PluginRow[]): ZonePlugin[] {
  return rows
    .filter(
      (row): row is ZonePlugin => row.state === "ready" && row.enabled && row.manifest != null,
    )
    .sort((a, b) => a.installed_at - b.installed_at);
}

/**
 * Whether the plugin has a page to open. A native plugin always does, if only to show its status; a UI
 * plugin only when its manifest names an entry, since a visualizer-only plugin has no page.
 */
function hasPage(row: ZonePlugin): boolean {
  return row.tier === "native" || row.manifest.entry != null;
}

/** Where Settings lists a row. A row whose manifest cannot be read is listed under Plugins, where it is diagnosed. */
export function listingOf(row: PluginRow): PluginListing {
  return row.manifest?.listing ?? "plugins";
}

/** The rows Settings lists under Plugins, in the order given. */
export function listedRows(rows: readonly PluginRow[]): PluginRow[] {
  return rows.filter((row) => listingOf(row) === "plugins");
}

/** How many rows the Visualizers catalog manages instead of the Plugins list. */
export function catalogManagedCount(rows: readonly PluginRow[]): number {
  return rows.length - listedRows(rows).length;
}

/** The id of the catalog's first plugin family, by plugin name as the catalog orders them; null when none. */
export function firstCatalogFamily(rows: readonly PluginRow[]): string | null {
  const named = rows.filter((r) => listingOf(r) === "catalog" && r.manifest != null);
  named.sort((a, b) => a.manifest!.name.localeCompare(b.manifest!.name) || a.id.localeCompare(b.id));
  return named[0]?.id ?? null;
}

/**
 * The plugins the rail and the finder may show, in install order: the live ones listed under Plugins
 * with a page that are visible under the app mode. Anything else is reachable from Settings only.
 */
export function qualifiedPlugins(rows: readonly PluginRow[], appMode: AppMode): ZonePlugin[] {
  return livePlugins(rows).filter(
    (row) =>
      row.manifest.listing === "plugins" && hasPage(row) && isPluginVisible(appMode, row.manifest.modes),
  );
}

/** One plugin-owned sidebar section with its items and fold state. */
export interface ZoneSection {
  plugin: ZonePlugin;
  items: PluginSidebarItem[];
  collapsed: boolean;
}

/** The plugin zone: owned sections first, then the plugins sharing one compact group. */
export interface PluginZoneModel {
  sections: ZoneSection[];
  compact: ZonePlugin[];
}

/**
 * Sorts the qualified plugins into the zone. A plugin owns a section only when its manifest declares the
 * `section` layout and items; every other one is a row in the shared group. Both lists keep install order.
 */
export function pluginZoneModel(rows: readonly PluginRow[], appMode: AppMode): PluginZoneModel {
  const sections: ZoneSection[] = [];
  const compact: ZonePlugin[] = [];
  for (const plugin of qualifiedPlugins(rows, appMode)) {
    const items = plugin.manifest.sidebar?.items ?? [];
    if (plugin.manifest.sidebar?.layout === "section" && items.length > 0) {
      sections.push({ plugin, items, collapsed: plugin.sidebar_collapsed });
    } else {
      compact.push(plugin);
    }
  }
  return { sections, compact };
}

/**
 * The nav item a plugin page's current route lights: the first nav item declaring that route, null
 * when none does. Two items sharing a route never both light.
 */
export function activeNavItemId(
  items: readonly PluginSidebarItem[],
  route: string | null,
): string | null {
  return items.find((item) => item.type === "nav" && item.route === route)?.id ?? null;
}

/** Whether the plugin is drawn in the zone, as a section or as a row in the shared group. */
export function zoneHasPlugin(model: PluginZoneModel, id: string): boolean {
  return (
    model.sections.some((section) => section.plugin.id === id) ||
    model.compact.some((plugin) => plugin.id === id)
  );
}

/** Whether the zone has anything to draw; an empty zone renders nothing, label included. */
export function isZoneEmpty(model: PluginZoneModel): boolean {
  return model.sections.length === 0 && model.compact.length === 0;
}
