/*
 * The visualizer catalog: which kinds and families the user turned off. The stored value lists only the
 * turned-off ids, so a kind or family the registry gains later arrives on. Ids are plain strings: one the
 * registry does not know is never offered and is kept untouched on every write. Installed plugin kinds
 * join as entries of their `plugin:<id>` families, after the built-ins. A kind stored under a former id
 * reads as its current id, and the next toggle writes the current id; reading never writes.
 *
 * A read that failed, or a value written by a newer version, offers every kind and refuses every write,
 * so an unreadable value can neither hide all visualizers nor be overwritten. At least one built-in kind
 * always stays offered, as a plugin can go away; Off is always offered and never an entry.
 */

// -- State Imports --
import {
  familyLabel,
  isPluginFamily,
  isPluginKindId,
  PLUGIN_FAMILY_PREFIX,
  pluginVisualizerRevision,
  pluginVisualizers,
  resolveAlias,
} from "./pluginVisualizers";
import { GROUP_ORDER, VISUALIZER_DESCRIPTORS } from "./visualizerRegistry";

/** A kind the catalog can offer, with its family. */
export interface CatalogEntry {
  id: string;
  group: string;
}

/** The stored choice: the kind ids and family ids turned off, in stored order. */
export interface CatalogState {
  kinds: readonly string[];
  groups: readonly string[];
}

export interface ParsedCatalog {
  state: CatalogState;
  writable: boolean;
}

/** A family with its offered kinds, in registry order. */
export interface OfferedGroup {
  id: string;
  kinds: readonly string[];
}

export interface Catalog {
  state: CatalogState;
  writable: boolean;
  entries: readonly CatalogEntry[];
  // Offered kinds in registry order, Off excluded.
  offeredKinds: readonly string[];
  // Families with at least one offered kind, in family order.
  offeredFamilies: readonly OfferedGroup[];
  // Where a pick that is no longer offered lands: Ridge when offered, else the first offered kind.
  fallback: string;
}

export interface FamilyState {
  // Off only when the family itself is switched off; mixed when on with some or all kinds off.
  state: "on" | "mixed" | "off";
  offered: number;
  total: number;
}

export const BUILTIN_ENTRIES: readonly CatalogEntry[] = VISUALIZER_DESCRIPTORS.map((d) => ({
  id: d.id,
  group: d.group,
}));

const CATALOG_VERSION = 1;
const PREFERRED_FALLBACK = "ridge";
const NOTHING_OFF: CatalogState = { kinds: [], groups: [] };

/** Keeps the string members of a stored list, first occurrence wins. */
function idList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id): id is string => typeof id === "string"))];
}

/** Reads the stored value. A failed read and a newer version are the two cases that refuse writes. */
export function parseCatalog(raw: string | null | undefined, failed: boolean): ParsedCatalog {
  if (failed) return { state: NOTHING_OFF, writable: false };
  if (!raw) return { state: NOTHING_OFF, writable: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: NOTHING_OFF, writable: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: NOTHING_OFF, writable: true };
  }
  const o = parsed as { v?: unknown; kinds?: unknown; groups?: unknown };
  // A newer version is any number from the next one up; any other version is garbage and may be replaced.
  if (typeof o.v === "number" && o.v >= CATALOG_VERSION + 1) return { state: NOTHING_OFF, writable: false };
  if (o.v !== CATALOG_VERSION) return { state: NOTHING_OFF, writable: true };
  return { state: { kinds: idList(o.kinds), groups: idList(o.groups) }, writable: true };
}

/** The stored form: compact JSON, keys in a fixed order, duplicates dropped. */
export function serializeCatalog(state: CatalogState): string {
  return JSON.stringify({ v: CATALOG_VERSION, kinds: [...new Set(state.kinds)], groups: [...new Set(state.groups)] });
}

const isBuiltinEntry = (e: CatalogEntry): boolean => !isPluginKindId(e.id);

/** A plugin family's sort key: its plugin's name, or the id after the prefix when the plugin is gone. */
const pluginFamilyName = (id: string): string => familyLabel(id) ?? id.slice(PLUGIN_FAMILY_PREFIX.length);

function byPluginName(a: string, b: string): number {
  return pluginFamilyName(a).localeCompare(pluginFamilyName(b)) || a.localeCompare(b);
}

/** Family order: the registry's own, then any other family the entries name, then plugin families by plugin name. */
export function familyOrder(entries: readonly CatalogEntry[]): string[] {
  const present = [...new Set(entries.map((e) => e.group))];
  const plugins = present.filter(isPluginFamily).sort(byPluginName);
  const others = present.filter((g) => !isPluginFamily(g));
  return [...new Set<string>([...GROUP_ORDER, ...others])].filter((g) => others.includes(g)).concat(plugins);
}

function offeredUnder(state: CatalogState, entries: readonly CatalogEntry[]): string[] {
  const kindsOff = new Set(state.kinds);
  const groupsOff = new Set(state.groups);
  return entries.filter((e) => !kindsOff.has(e.id) && !groupsOff.has(e.group)).map((e) => e.id);
}

/** The offered built-in kinds: the ones a plugin going away cannot take with it. */
function offeredBuiltins(state: CatalogState, entries: readonly CatalogEntry[]): string[] {
  return offeredUnder(state, entries.filter(isBuiltinEntry));
}

/** Combines the stored value with the registry entries. */
export function buildCatalog(
  raw: string | null | undefined,
  failed: boolean,
  entries: readonly CatalogEntry[] = BUILTIN_ENTRIES,
): Catalog {
  const parsed = parseCatalog(raw, failed);
  const kinds = [...new Set(parsed.state.kinds.map(resolveAlias))];
  let state: CatalogState = { kinds, groups: parsed.state.groups };
  // A stored value that offers no built-in drops its known built-in kind and family ids, so they are all on.
  // Unknown ids and plugin ids stay so the next write keeps them.
  const builtins = entries.filter(isBuiltinEntry);
  if (offeredBuiltins(state, entries).length === 0 && builtins.length > 0) {
    const knownKinds = new Set(builtins.map((e) => e.id));
    const knownGroups = new Set(builtins.map((e) => e.group));
    state = {
      kinds: state.kinds.filter((id) => !knownKinds.has(id)),
      groups: state.groups.filter((id) => !knownGroups.has(id)),
    };
  }
  const offeredKinds = offeredUnder(state, entries);
  const offered = new Set(offeredKinds);
  const offeredFamilies = familyOrder(entries)
    .map((id) => ({ id, kinds: entries.filter((e) => e.group === id && offered.has(e.id)).map((e) => e.id) }))
    .filter((g) => g.kinds.length > 0);
  return {
    state,
    writable: parsed.writable,
    entries,
    offeredKinds,
    offeredFamilies,
    fallback: offered.has(PREFERRED_FALLBACK)
      ? PREFERRED_FALLBACK
      : offeredBuiltins(state, entries)[0] ?? PREFERRED_FALLBACK,
  };
}

/** Every kind offered, writable: the catalog of an empty stored value. */
export const ALL_OFFERED: Catalog = buildCatalog(undefined, false);

let memoRaw: string | null | undefined;
let memoFailed = false;
let memoRevision = 0;
let memo: Catalog = ALL_OFFERED;

/**
 * `buildCatalog` over the built-in entries and the installed plugin kinds, returning the same object for
 * the same inputs and plugin table.
 */
export function catalogOf(raw: string | null | undefined, failed: boolean): Catalog {
  const revision = pluginVisualizerRevision();
  if (raw !== memoRaw || failed !== memoFailed || revision !== memoRevision) {
    memoRaw = raw;
    memoFailed = failed;
    memoRevision = revision;
    const plugins = pluginVisualizers().map((d): CatalogEntry => ({ id: d.id, group: d.family }));
    memo = buildCatalog(raw, failed, plugins.length > 0 ? [...BUILTIN_ENTRIES, ...plugins] : BUILTIN_ENTRIES);
  }
  return memo;
}

/** Whether a kind is offered. Off always is. */
export function isOffered(catalog: Catalog, kind: string): boolean {
  return kind === "off" || catalog.offeredKinds.includes(kind);
}

/** The families with at least one offered kind, in family order. */
export function offeredGroups(catalog: Catalog): readonly OfferedGroup[] {
  return catalog.offeredFamilies;
}

export function familyState(catalog: Catalog, group: string): FamilyState {
  const members = catalog.entries.filter((e) => e.group === group);
  const offered = members.filter((e) => catalog.offeredKinds.includes(e.id)).length;
  const total = members.length;
  if (catalog.state.groups.includes(group)) return { state: "off", offered, total };
  return { state: offered < total ? "mixed" : "on", offered, total };
}

/** The next state if `next` still offers a built-in kind, else null. Plugin kinds never count. */
function guarded(catalog: Catalog, next: CatalogState): CatalogState | null {
  return offeredBuiltins(next, catalog.entries).length > 0 ? next : null;
}

/**
 * Flips one kind. Null when the catalog is not writable, the id is unknown, its family is off, or the
 * result would offer no kind.
 */
export function toggleKind(catalog: Catalog, kind: string): CatalogState | null {
  const entry = catalog.entries.find((e) => e.id === kind);
  if (!catalog.writable || !entry || catalog.state.groups.includes(entry.group)) return null;
  const { kinds, groups } = catalog.state;
  if (kinds.includes(kind)) return { kinds: kinds.filter((id) => id !== kind), groups };
  return guarded(catalog, { kinds: [...kinds, kind], groups });
}

/**
 * Flips one family's own switch; the kinds' stored states are never touched. Null when the catalog is not
 * writable, the family has no entry, or the result would offer no kind.
 */
export function toggleGroup(catalog: Catalog, group: string): CatalogState | null {
  if (!catalog.writable || !catalog.entries.some((e) => e.group === group)) return null;
  const { kinds, groups } = catalog.state;
  if (groups.includes(group)) return { kinds, groups: groups.filter((id) => id !== group) };
  return guarded(catalog, { kinds, groups: [...groups, group] });
}

/**
 * Turns every family but `keep` off and `keep` on. Only `groups` changes: kinds and ids the registry
 * does not know stay as stored. Null when the catalog is not writable, `keep` has no entry, or the
 * result would offer no kind.
 */
export function keepOnlyGroup(catalog: Catalog, keep: string): CatalogState | null {
  if (!catalog.writable || !catalog.entries.some((e) => e.group === keep)) return null;
  const known = new Set(catalog.entries.map((e) => e.group));
  const others = [...known].filter((g) => g !== keep);
  const kept = catalog.state.groups.filter((g) => g !== keep);
  return guarded(catalog, {
    kinds: catalog.state.kinds,
    groups: [...kept, ...others.filter((g) => !kept.includes(g))],
  });
}

/** Whether `keep` is the only family on: it is not turned off and every other known family is. */
export function isOnlyGroup(catalog: Catalog, keep: string): boolean {
  const known = new Set(catalog.entries.map((e) => e.group));
  if (!known.has(keep)) return false;
  const off = new Set(catalog.state.groups);
  return !off.has(keep) && [...known].every((g) => g === keep || off.has(g));
}

/** The state with every known family turned back on; kinds and unknown ids stay as stored. */
export function allGroupsOn(catalog: Catalog): CatalogState {
  const known = new Set(catalog.entries.map((e) => e.group));
  return { kinds: catalog.state.kinds, groups: catalog.state.groups.filter((g) => !known.has(g)) };
}

/** Whether a kind or family that is on can be turned off: the same guard the toggles apply. */
export function canTurnOff(catalog: Catalog, scope: "kind" | "group", id: string): boolean {
  if (scope === "kind") return !catalog.state.kinds.includes(id) && toggleKind(catalog, id) !== null;
  return !catalog.state.groups.includes(id) && toggleGroup(catalog, id) !== null;
}

/** The kind after `kind` in the V cycle: offered kinds, then Off, wrapping. An unlisted kind goes to the first. */
export function nextOfferedKind(catalog: Catalog, kind: string): string {
  const cycle = [...catalog.offeredKinds, "off"];
  const i = cycle.indexOf(kind);
  return i < 0 ? cycle[0] : cycle[(i + 1) % cycle.length];
}
