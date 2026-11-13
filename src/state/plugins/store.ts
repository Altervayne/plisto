/*
 * The plugins store: the registry rows, the boot state and whether the last read worked. Rows are
 * replaced only when their content changed and an unchanged row keeps its object, so a selector hands
 * back the same reference across an unrelated update. A failed read never clears the rows.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Type Imports --
import type { PluginBootState, PluginRow } from "../../types";

/** Where the plugins read stands. */
export type PluginsLoadStatus = "idle" | "loading" | "ready" | "failed";

interface PluginsStore {
  rows: PluginRow[];
  /** Null until the boot state has been read once. */
  boot: PluginBootState | null;
  status: PluginsLoadStatus;
  setStatus: (status: PluginsLoadStatus) => void;
  /** Applies a fresh listing, keeping the rows and the array that did not change. */
  applyRows: (rows: PluginRow[]) => void;
  applyBoot: (boot: PluginBootState) => void;
}

const sameRow = (a: PluginRow, b: PluginRow): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The previous array and rows where content matches, so unchanged data keeps its references. */
function reuse(prev: PluginRow[], next: PluginRow[]): PluginRow[] {
  const byId = new Map(prev.map((row) => [row.id, row]));
  const merged = next.map((row) => {
    const old = byId.get(row.id);
    return old && sameRow(old, row) ? old : row;
  });
  const unchanged = merged.length === prev.length && merged.every((row, i) => row === prev[i]);
  return unchanged ? prev : merged;
}

export const usePluginsStore = create<PluginsStore>((set) => ({
  rows: [],
  boot: null,
  status: "idle",
  setStatus: (status) => set({ status }),
  applyRows: (rows) => set((s) => ({ rows: reuse(s.rows, rows) })),
  applyBoot: (boot) =>
    set((s) => (s.boot && s.boot.safe_mode === boot.safe_mode && s.boot.unclean === boot.unclean ? s : { boot })),
}));

// The enabled slice is derived once per rows array, so a selector returns the same array until rows change.
let enabledFrom: PluginRow[] | null = null;
let enabledRows: PluginRow[] = [];

export function enabledOf(rows: PluginRow[]): PluginRow[] {
  if (enabledFrom !== rows) {
    enabledFrom = rows;
    enabledRows = rows.filter((row) => row.enabled);
  }
  return enabledRows;
}

// -- Selectors (narrow: one value each, stable until it changes) --

export const usePlugins = (): PluginRow[] => usePluginsStore((s) => s.rows);
export const usePlugin = (id: string): PluginRow | undefined =>
  usePluginsStore((s) => s.rows.find((row) => row.id === id));
export const useEnabledPlugins = (): PluginRow[] => usePluginsStore((s) => enabledOf(s.rows));
export const usePluginsStatus = (): PluginsLoadStatus => usePluginsStore((s) => s.status);
export const usePluginsBoot = (): PluginBootState | null => usePluginsStore((s) => s.boot);
