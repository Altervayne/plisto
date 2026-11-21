/*
 * The visualizer kinds that installed plugins declare, as one table keyed by `<plugin id>/<kind id>`.
 * Built from the enabled, ready plugin rows and sorted by plugin name, so the table order is the catalog's
 * family order. The revision bumps only when the table's content changes, so a memo keyed on it rebuilds
 * only then.
 *
 * The table follows the rows alone, never the runtime gate: a plugin held for the user's answer or off
 * for a safe-mode session keeps its kinds here, so its stored picks stay known. Whether a kind can run
 * is the stage's question.
 *
 * Type imports only: every scene reaches this module through visualizerKind, so it must stay free of the
 * store, React and IPC. The plugins store feeds it.
 */

// -- Type Imports --
import type { PluginRow } from "../../types";
import type {
  PluginVisualizerLook,
  PluginVisualizerNeeds,
  PluginVisualizerPreset,
  PluginVisualizerSetting,
} from "../plugins/visualizerDecl";

/** A plugin kind id: `<plugin id>/<kind id>`. */
export type PluginKindId = `${string}/${string}`;

/** A plugin's family id: `plugin:<plugin id>`, which no built-in family can collide with. */
export type PluginFamilyId = `plugin:${string}`;

/** One plugin kind, as the app reads it. */
export interface PluginVisualizerDescriptor {
  id: PluginKindId;
  pluginId: string;
  // The kind's own id inside its plugin.
  kindId: string;
  family: PluginFamilyId;
  pluginName: string;
  name: string;
  look: PluginVisualizerLook;
  needs: PluginVisualizerNeeds;
  fillsStage: boolean;
  darkOnly: boolean;
  settings: readonly PluginVisualizerSetting[];
  presets: readonly PluginVisualizerPreset[];
  // Former kind ids inside the same plugin, as full ids.
  aliases: readonly PluginKindId[];
  version: string;
  manifestHash: string;
}

export const PLUGIN_FAMILY_PREFIX = "plugin:";
// The plugin id and kind id rules of the manifest: reverse-DNS of 3 to 64 bytes, then 1 to 24 bytes.
const PLUGIN_ID = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const KIND_ID = /^[a-z0-9-]{1,24}$/;

let table: readonly PluginVisualizerDescriptor[] = [];
let byId = new Map<string, PluginVisualizerDescriptor>();
let aliasOf = new Map<string, PluginKindId>();
let nameOf = new Map<string, string>();
let revision = 0;
let fedFrom: readonly PluginRow[] | null = null;
let fedKey = "[]";

/** Whether a string is a well-formed plugin kind id, installed or not. */
export function isPluginKindId(raw: string | null | undefined): raw is PluginKindId {
  if (!raw) return false;
  const slash = raw.indexOf("/");
  if (slash < 0) return false;
  const plugin = raw.slice(0, slash);
  return plugin.length >= 3 && plugin.length <= 64 && PLUGIN_ID.test(plugin) && KIND_ID.test(raw.slice(slash + 1));
}

export function isPluginFamily(id: string): id is PluginFamilyId {
  return id.startsWith(PLUGIN_FAMILY_PREFIX);
}

export function pluginFamilyOf(pluginId: string): PluginFamilyId {
  return `${PLUGIN_FAMILY_PREFIX}${pluginId}`;
}

function descriptorsOf(row: PluginRow): PluginVisualizerDescriptor[] {
  const manifest = row.manifest;
  if (!row.enabled || row.state !== "ready" || !manifest) return [];
  return manifest.visualizers.map((decl) => ({
    id: `${row.id}/${decl.id}`,
    pluginId: row.id,
    kindId: decl.id,
    family: pluginFamilyOf(row.id),
    pluginName: manifest.name,
    name: decl.name,
    look: decl.look,
    needs: decl.needs,
    fillsStage: decl.fills_stage,
    darkOnly: decl.dark_only,
    settings: decl.settings,
    presets: decl.presets,
    aliases: decl.aliases.map((alias): PluginKindId => `${row.id}/${alias}`),
    version: row.version,
    manifestHash: row.manifest_hash,
  }));
}

function byPluginName(a: PluginRow, b: PluginRow): number {
  return (a.manifest?.name ?? "").localeCompare(b.manifest?.name ?? "") || a.id.localeCompare(b.id);
}

/** Rebuilds the table from the plugin rows. An unchanged rows array or unchanged content is a no-op. */
export function applyPluginRows(rows: readonly PluginRow[]): void {
  if (rows === fedFrom) return;
  fedFrom = rows;
  const next = [...rows].sort(byPluginName).flatMap(descriptorsOf);
  const key = JSON.stringify(next);
  if (key === fedKey) return;
  fedKey = key;
  table = next;
  byId = new Map(next.map((d) => [d.id, d]));
  aliasOf = new Map(next.flatMap((d) => d.aliases.map((alias): [string, PluginKindId] => [alias, d.id])));
  nameOf = new Map(next.map((d) => [d.family, d.pluginName]));
  revision += 1;
}

/** Every plugin kind, plugins by name and kinds in declared order. */
export function pluginVisualizers(): readonly PluginVisualizerDescriptor[] {
  return table;
}

/** Bumped by every change to the table. */
export function pluginVisualizerRevision(): number {
  return revision;
}

/** The descriptor of an installed plugin kind; undefined for any other string. */
export function pluginVisualizer(id: string): PluginVisualizerDescriptor | undefined {
  return byId.get(id);
}

/** A plugin family's label: its plugin's name. Null for a family with no installed kind. */
export function familyLabel(family: string): string | null {
  return nameOf.get(family) ?? null;
}

/** The current id for a former id an installed kind lists as an alias; any other string comes back as is. */
export function resolveAlias<T extends string>(id: T): T | PluginKindId {
  return aliasOf.get(id) ?? id;
}

/**
 * Whether a kind waits on the plugins list: a plugin kind id the table neither holds nor knows as an
 * alias, while no listing has applied. Such a kind is neither installed nor gone yet, so nothing may stand
 * in for it.
 */
export function isPendingPluginKind(kind: string, listed: boolean): boolean {
  return !listed && isPluginKindId(kind) && !byId.has(kind) && !aliasOf.has(kind);
}
