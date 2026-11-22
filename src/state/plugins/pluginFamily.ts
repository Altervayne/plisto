/*
 * How the Visualizers catalog shows a plugin's family, as pure code: its status, what its switch does, and
 * what an accepted review or a changed listing does to it. Nothing here reads a store or writes; the
 * catalog page passes the row, the boot view, the supervised status and the stored off-families in, and
 * calls the real actions from what comes back.
 *
 * A visualizer-only plugin's switch is the plugin's own enabled state. A mixed plugin (one with a page, so
 * listed under Plugins) keeps its enabled state in Plugins; its switch here is the catalog flag of its
 * family, so the two never stand in for each other.
 */

// -- State Imports --
import { pluginFamilyOf } from "../player/pluginVisualizers";

// -- Utils Imports --
import { listingOf } from "../../components/shell/navVisibility";

// -- Type Imports --
import type { PluginFamilyId } from "../player/pluginVisualizers";
import type { PluginBootState, PluginListing, PluginRow, PluginStatus } from "../../types";

/** What a family says about its plugin. */
export type FamilyStatus = "on" | "off" | "review" | "newer" | "broken" | "crash" | "safe" | "offInPlugins";

/** What flipping a family's switch does: the plugin's enabled state, or the family's catalog flag. */
export type FamilySwitchAction =
  | { kind: "plugin"; enable: boolean; clearFlag: PluginFamilyId | null }
  | { kind: "catalog"; family: PluginFamilyId; on: boolean };

/** The one action that takes the switch's place in the heading row. */
export type FamilyInlineAction = "review" | "restart" | "uninstall";

/** A link the status line carries: to the plugin's row in Plugins, or the way out of safe mode. */
export type FamilyLink = "plugins" | "restartNormally";

export interface FamilyView {
  status: FamilyStatus;
  checked: boolean;
  /** The switch shows but cannot be flipped. */
  locked: boolean;
  /** What a flip does; null while the switch is locked or an inline action replaces it. */
  flip: FamilySwitchAction | null;
  inline: FamilyInlineAction | null;
  link: FamilyLink | null;
  /** Whether the family unfolds into a detail panel. */
  expandable: boolean;
  /** Whether the family lists its kinds. */
  tiles: boolean;
  warn: boolean;
}

/** What the view reads beside the row. */
export interface FamilyContext {
  boot: PluginBootState | null;
  /** The plugin's supervised status, when it has one. */
  status: PluginStatus | undefined;
  /** The family ids the stored catalog turns off. */
  groupsOff: readonly string[];
}

/**
 * Whether the plugin has a family in the catalog: a readable manifest that lists there or brings
 * visualizers.
 */
export function hasFamily(row: PluginRow): boolean {
  const manifest = row.manifest;
  return manifest != null && (manifest.listing === "catalog" || manifest.visualizers.length > 0);
}

/** Whether the plugin is listed under Plugins, which keeps its enabled state there. */
export function isMixed(row: PluginRow): boolean {
  return listingOf(row) === "plugins";
}

/*
 * Precedence, first match wins: broken, newer, review, crash, then (for a plugin that is off) off or
 * off in Plugins, then safe, then a stored family flag as off, else on. The row's problem states
 * outrank everything, and a crash loop outranks off because Plisto turns the plugin off itself.
 */
function statusOf(row: PluginRow, ctx: FamilyContext): FamilyStatus {
  if (row.state === "broken") return "broken";
  if (row.state === "incompatible") return "newer";
  if (row.state === "needs_consent") return "review";
  if (ctx.boot?.runtime === "running" && ctx.status?.host === "crash_loop") return "crash";
  if (!row.enabled) return isMixed(row) ? "offInPlugins" : "off";
  if (ctx.boot?.runtime === "safe") return "safe";
  if (ctx.groupsOff.includes(pluginFamilyOf(row.id))) return "off";
  return "on";
}

const BASE: FamilyView = {
  status: "on",
  checked: false,
  locked: false,
  flip: null,
  inline: null,
  link: null,
  expandable: true,
  tiles: true,
  warn: false,
};

/** The family's status and what its heading row offers. */
export function familyView(row: PluginRow, ctx: FamilyContext): FamilyView {
  const status = statusOf(row, ctx);
  const mixed = isMixed(row);
  const family = pluginFamilyOf(row.id);
  const view = { ...BASE, status };
  switch (status) {
    case "broken":
      return { ...view, inline: "uninstall", expandable: false, tiles: false, warn: true };
    case "newer":
      return { ...view, locked: true };
    case "review":
      return mixed ? { ...view, locked: true, link: "plugins" } : { ...view, inline: "review" };
    case "crash":
      return mixed
        ? { ...view, locked: true, link: "plugins", warn: true }
        : { ...view, inline: "restart", warn: true };
    case "offInPlugins":
      return { ...view, locked: true, link: "plugins" };
    case "off":
    case "on":
    case "safe": {
      const on = status !== "off";
      // A stored flag on a visualizer-only family still hides its kinds, so turning it on clears it.
      const flagged = ctx.groupsOff.includes(family);
      const flip: FamilySwitchAction = mixed
        ? { kind: "catalog", family, on: !on }
        : { kind: "plugin", enable: !on, clearFlag: flagged && !on ? family : null };
      return { ...view, checked: on, flip, link: status === "safe" ? "restartNormally" : null };
    }
  }
}

/** What accepting a plugin's review does to its family. */
export interface ReviewLanding {
  /** A visualizer-only plugin lands turned on; a mixed one stays off until enabled in Plugins. */
  enablePlugin: boolean;
  /** The family's catalog flag to clear, so the family is on as soon as the plugin is. */
  clearFlag: PluginFamilyId;
}

/** The landing after an accepted review; null for a plugin with no family. */
export function reviewLanding(row: PluginRow): ReviewLanding | null {
  if (!hasFamily(row)) return null;
  return { enablePlugin: !isMixed(row), clearFlag: pluginFamilyOf(row.id) };
}

/** What an update does to a family when it moves the plugin between the two listings. */
export interface ListingChange {
  to: PluginListing;
  /** Whose state the family's switch follows from now on. */
  control: "plugin" | "catalog";
  /** Whether the family is still in the catalog after the update. */
  family: "stays" | "gone";
  /**
   * The family's catalog flag to clear: a plugin that turns visualizer-only is governed by its enabled
   * state alone.
   */
  clearFlag: PluginFamilyId | null;
  /** Which notice says where the plugin went. */
  notice: "ownPage" | "managedInVisualizers";
}

/** The change an update makes to a plugin's family; null when the listing is the same or unreadable. */
export function listingChange(before: PluginRow, after: PluginRow): ListingChange | null {
  if (!before.manifest || !after.manifest) return null;
  const to = listingOf(after);
  if (listingOf(before) === to) return null;
  const toCatalog = to === "catalog";
  return {
    to,
    control: toCatalog ? "plugin" : "catalog",
    family: hasFamily(after) ? "stays" : "gone",
    clearFlag: toCatalog ? pluginFamilyOf(after.id) : null,
    notice: toCatalog ? "managedInVisualizers" : "ownPage",
  };
}
