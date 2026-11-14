/*
 * The supervised status of every serving plugin, by id, as Rust reports it. Each status carries a
 * per-plugin revision: one that is not newer than the held one is stale and dropped, so a late event or a
 * slow read never rolls a plugin back. Writes that change nothing keep the state.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Type Imports --
import type { PluginStatus } from "../../types";

type StatusMap = Readonly<Record<string, PluginStatus>>;

interface PluginStatusStore {
  statuses: StatusMap;
  /** Takes one status when it is newer than the held one. */
  apply: (status: PluginStatus) => void;
  /** Takes every status of a listing that is newer than its held one. */
  applyAll: (list: readonly PluginStatus[]) => void;
  clear: () => void;
}

function merged(held: StatusMap, incoming: readonly PluginStatus[]): StatusMap {
  let next: Record<string, PluginStatus> | null = null;
  for (const status of incoming) {
    const current = (next ?? held)[status.id];
    if (current && status.rev <= current.rev) continue;
    next ??= { ...held };
    next[status.id] = status;
  }
  return next ?? held;
}

export const usePluginStatusStore = create<PluginStatusStore>((set) => ({
  statuses: {},
  apply: (status) => set((s) => ({ statuses: merged(s.statuses, [status]) })),
  applyAll: (list) => set((s) => ({ statuses: merged(s.statuses, list) })),
  clear: () => set((s) => (Object.keys(s.statuses).length === 0 ? s : { statuses: {} })),
}));

/** The ids whose host state turned to `starting` between two snapshots. */
export function startingEdges(prev: StatusMap, next: StatusMap): string[] {
  return Object.keys(next).filter((id) => next[id].host === "starting" && prev[id]?.host !== "starting");
}

// -- Selectors --

export const usePluginStatusOf = (id: string): PluginStatus | undefined =>
  usePluginStatusStore((s) => s.statuses[id]);
