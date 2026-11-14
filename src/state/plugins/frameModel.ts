/*
 * Which plugin frames should exist, as pure code. A frame is wanted for the open page of a UI plugin or of
 * a native plugin that declares a `page`, and for every UI plugin that declares the `background`
 * capability. The layer mounts what this returns and unmounts the rest; nothing is kept for later. Background frames follow the live set, not the app mode:
 * the mode only hides entry points, it is not a runtime switch.
 */

// -- Utils Imports --
import { livePlugins, qualifiedPlugins } from "../../components/shell/navVisibility";

// -- Type Imports --
import type { ZonePlugin } from "../../components/shell/navVisibility";
import type { AppMode } from "../player/store";
import type { PluginBootState, PluginRow, PluginTier } from "../../types";

/** How long a released background frame holds the next release back, in ms. */
export const RELEASE_GAP_MS = 2000;

/** Where a mounted frame stands, as the layer reports it. */
export type FramePhase = "loading" | "live" | "not_responding" | "crashed" | "unavailable";

/** One frame the layer should have mounted. */
export interface FrameWant {
  mountKey: string;
  id: string;
  kind: "page" | "background";
  entry: string;
  name: string;
  tier: PluginTier;
  /** Whether this frame is the shown page. */
  active: boolean;
}

/** Whether frames may run at all: Rust's runtime gate, closed while held or safe and before it is read. */
export function pluginRuntimeReady(boot: PluginBootState | null): boolean {
  return boot?.runtime === "running";
}

/** Whether the row is a live UI plugin, or a live native plugin with a page, so it can own a frame. */
export function frameCapable(row: PluginRow): row is ZonePlugin {
  if (livePlugins([row]).length !== 1) return false;
  return row.tier === "ui" || (row.tier === "native" && row.manifest?.page != null);
}

/** Whether the row's frame stays mounted without its page open. A native page never does. */
export function runsInBackground(row: PluginRow): row is ZonePlugin {
  return frameCapable(row) && row.tier === "ui" && row.granted.includes("background");
}

/** The file a row's frame loads: a native plugin's page, a UI plugin's entry. */
export function frameEntry(row: ZonePlugin): string {
  return row.tier === "native" ? (row.manifest.page ?? row.manifest.entry) : row.manifest.entry;
}

/** Whether a crashed row's frame is remounted when its status reaches `starting`: background frames only. */
export function remountsOnStarting(row: PluginRow, crashed: ReadonlySet<string>): boolean {
  return runsInBackground(row) && crashed.has(crashKey(row));
}

/** The crash key of a row: its identity without the restart generation. */
export function crashKey(row: PluginRow): string {
  return `${row.id}|${row.version}|${row.manifest_hash}`;
}

export interface WantedInput {
  rows: readonly PluginRow[];
  appMode: AppMode;
  /** The plugin whose page is the shown destination, or null. */
  pageId: string | null;
  runtime: boolean;
  /** Crash keys of frames that crashed and were not restarted. */
  crashed: ReadonlySet<string>;
  /** Ids of background plugins the stagger has released. */
  released: ReadonlySet<string>;
  /** Restart count per id. */
  generation: Readonly<Record<string, number>>;
}

/** The frames to have mounted: background ones in install order, then the page frame. */
export function wantedFrames(input: WantedInput): FrameWant[] {
  const { rows, appMode, pageId, runtime, crashed, released, generation } = input;
  if (!runtime) return [];

  const keyOf = (row: PluginRow) => `${crashKey(row)}|${generation[row.id] ?? 0}`;
  const want = (row: ZonePlugin, kind: FrameWant["kind"], active: boolean): FrameWant => ({
    mountKey: keyOf(row),
    id: row.id,
    kind,
    entry: frameEntry(row),
    name: row.manifest.name,
    tier: row.tier,
    active,
  });

  const qualified = new Set(qualifiedPlugins(rows, appMode).map((row) => row.id));
  const pageShows = (row: ZonePlugin) => row.id === pageId && qualified.has(row.id);
  const wants: FrameWant[] = [];

  for (const row of livePlugins(rows)) {
    if (!runsInBackground(row) || crashed.has(crashKey(row))) continue;
    if (released.has(row.id) || row.id === pageId) wants.push(want(row, "background", pageShows(row)));
  }
  for (const row of livePlugins(rows)) {
    if (row.id !== pageId || !qualified.has(row.id)) continue;
    if (!frameCapable(row) || runsInBackground(row) || crashed.has(crashKey(row))) continue;
    wants.push(want(row, "page", true));
  }
  return wants;
}

/** The ids of the background plugins in install order, the order the stagger releases them. */
export function backgroundOrder(rows: readonly PluginRow[]): string[] {
  return livePlugins(rows)
    .filter(runsInBackground)
    .map((row) => row.id);
}

/**
 * The next background id to release, or null when none is due. The first unreleased id goes once the
 * previous released one is live (or has stopped trying) or has been mounted for RELEASE_GAP_MS.
 */
export function nextRelease(
  order: readonly string[],
  released: ReadonlySet<string>,
  phaseOf: (id: string) => FramePhase | undefined,
  mountedAt: (id: string) => number | undefined,
  now: number,
): string | null {
  const index = order.findIndex((id) => !released.has(id));
  if (index === -1) return null;
  if (index === 0) return order[0];
  const previous = order[index - 1];
  const phase = phaseOf(previous);
  const at = mountedAt(previous);
  const settled = phase === "live" || phase === "crashed" || phase === "unavailable";
  if (settled || (at !== undefined && now - at >= RELEASE_GAP_MS)) return order[index];
  return null;
}
