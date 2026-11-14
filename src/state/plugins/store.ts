/*
 * The plugins store: the registry rows, the boot view and whether the last read worked. Rows are
 * replaced only when their content changed and an unchanged row keeps its object, so a selector hands
 * back the same reference across an unrelated update. A failed read never clears the rows.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Type Imports --
import type { PluginBootState, PluginRow, PluginRuntime } from "../../types";

/** Where the plugins read stands. */
export type PluginsLoadStatus = "idle" | "loading" | "ready" | "failed";

interface PluginsStore {
  rows: PluginRow[];
  /** The runtime gate and boot record. Null until read once; the runtime event keeps it current. */
  boot: PluginBootState | null;
  status: PluginsLoadStatus;
  /** Bumped by every local row change, so a listing that began before one can be told apart. */
  epoch: number;
  setStatus: (status: PluginsLoadStatus) => void;
  /** Applies a fresh listing, keeping the rows and the array that did not change. */
  applyRows: (rows: PluginRow[]) => void;
  applyBoot: (boot: PluginBootState) => void;
  /** Puts one row in place, appending it when its id is new. The next listing settles the order. */
  upsertRow: (row: PluginRow) => void;
  removeRow: (id: string) => void;
}

const sameRow = (a: PluginRow, b: PluginRow): boolean => JSON.stringify(a) === JSON.stringify(b);

// Rust does not send granted_origins yet; the slice that adds it to the row removes this default.
const withOrigins = (row: PluginRow): PluginRow =>
  Array.isArray(row.granted_origins) ? row : { ...row, granted_origins: [] };

/** The previous array and rows where content matches, so unchanged data keeps its references. */
function reuse(prev: PluginRow[], next: PluginRow[]): PluginRow[] {
  const byId = new Map(prev.map((row) => [row.id, row]));
  const merged = next.map((incoming) => {
    const row = withOrigins(incoming);
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
  epoch: 0,
  setStatus: (status) => set({ status }),
  applyRows: (rows) => set((s) => ({ rows: reuse(s.rows, rows) })),
  upsertRow: (incoming) =>
    set((s) => {
      const row = withOrigins(incoming);
      const at = s.rows.findIndex((r) => r.id === row.id);
      const epoch = s.epoch + 1;
      if (at < 0) return { rows: [...s.rows, row], epoch };
      if (sameRow(s.rows[at], row)) return { epoch };
      return { rows: s.rows.map((r, i) => (i === at ? row : r)), epoch };
    }),
  removeRow: (id) =>
    set((s) => ({
      rows: s.rows.some((r) => r.id === id) ? s.rows.filter((r) => r.id !== id) : s.rows,
      epoch: s.epoch + 1,
    })),
  applyBoot: (boot) =>
    set((s) =>
      s.boot &&
      s.boot.runtime === boot.runtime &&
      s.boot.unclean === boot.unclean &&
      s.boot.safe_flag === boot.safe_flag
        ? s
        : { boot },
    ),
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
export const usePluginRuntime = (): PluginRuntime | null => usePluginsStore((s) => s.boot?.runtime ?? null);
