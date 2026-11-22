/*
 * Crash breadcrumbs for offscreen mounts (a still or a thumbnail). A mount leaves an entry in local storage
 * before it starts and removes it when it exits, however it exits, so an entry left from an earlier launch
 * means a mount took Plisto down with it. Once the marks have been read at launch, each such entry whose
 * build is still installed lays a graphics reset on its kind, as a trial lost in a crash does, and every
 * leftover entry is cleared. Only an unclean previous exit marks: after a clean quit or an update the
 * entries are cleared unmarked. Storage that is unavailable or throws leaves the mounts running unwatched.
 */

// -- State Imports --
import { useNetPolicy, writeVisMark } from "./netPolicy";
import { usePluginsStore } from "../../plugins/store";

// -- Type Imports --
import type { PluginRow } from "../../../types";

export const CRUMBS_KEY = "plisto.vis.offscreen";

/** One live offscreen mount. */
export interface Crumb {
  // Unique per mount.
  id: string;
  // The launch that wrote it.
  launch: string;
  pluginId: string;
  kindId: string;
  sig: string;
}

/** The signature of an installed build, changing with its version, manifest and install time. */
export const buildSig = (row: PluginRow): string =>
  `${row.version}|${row.manifest_hash}|${row.installed_at}`;

const LAUNCH = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
let serial = 0;

// The storage, or null where reading it throws.
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(store: Storage): Crumb[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(CRUMBS_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as Crumb[]) : [];
  } catch {
    return [];
  }
}

function write(store: Storage, crumbs: readonly Crumb[]): void {
  try {
    if (crumbs.length === 0) store.removeItem(CRUMBS_KEY);
    else store.setItem(CRUMBS_KEY, JSON.stringify(crumbs));
  } catch {
    // A crumb that cannot be written or removed only goes unwatched.
  }
}

/** Leaves a crumb for a mount of the kind now; the returned release removes it. */
export function leaveCrumb(pluginId: string, kindId: string): () => void {
  const store = storage();
  if (!store) return () => {};
  const row = usePluginsStore.getState().rows.find((r) => r.id === pluginId);
  const sig = row ? buildSig(row) : "";
  const crumb: Crumb = { id: `${LAUNCH}:${++serial}`, launch: LAUNCH, pluginId, kindId, sig };
  write(store, [...read(store), crumb]);
  let left = true;
  return () => {
    if (!left) return;
    left = false;
    write(store, read(store).filter((c) => c.id !== crumb.id));
  };
}

/**
 * Clears the crumbs left by an earlier launch, first marking the kinds whose build is still installed when
 * that launch exited uncleanly.
 */
export function sweepCrumbs(rows: readonly PluginRow[], unclean: boolean): void {
  const store = storage();
  if (!store) return;
  const all = read(store);
  const marked = new Set<string>();
  for (const crumb of all) {
    if (!unclean || crumb.launch === LAUNCH) continue;
    const row = rows.find((r) => r.id === crumb.pluginId);
    const kind = `${crumb.pluginId}/${crumb.kindId}` as const;
    if (!row || buildSig(row) !== crumb.sig || marked.has(kind)) continue;
    marked.add(kind);
    void writeVisMark(kind, crumb.pluginId, crumb.kindId, "graphics_reset");
  }
  write(store, all.filter((c) => c.launch === LAUNCH));
}

/** Sweeps once the marks, the plugin rows and the boot state have been read; the teardown stops waiting. */
export function startCrumbSweep(): () => void {
  let done = false;
  const stops: (() => void)[] = [];
  const check = () => {
    const { listed, boot, rows } = usePluginsStore.getState();
    if (done || !useNetPolicy.getState().loaded || !listed || !boot) return;
    done = true;
    sweepCrumbs(rows, boot.unclean);
    for (const stop of stops) stop();
  };
  stops.push(useNetPolicy.subscribe(check), usePluginsStore.subscribe(check));
  check();
  return () => {
    for (const stop of stops) stop();
  };
}
