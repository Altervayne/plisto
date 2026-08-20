/*
 * The export scope: the album/single ids a scoped export is narrowed to. Null is the general export -
 * the whole organized library, filtered only by the Include and date controls. A non-null array pins
 * the run to exactly those ids, set from a grid multi-select elsewhere. The Export screen reads this to
 * switch modes, and clears it on leaving so a fresh visit always opens general.
 */

// -- Library Imports --
import { create } from "zustand";

interface ScopeStore {
  albumIds: number[] | null;
  setScope: (ids: number[]) => void;
  clearScope: () => void;
}

export const useExportScopeStore = create<ScopeStore>((set) => ({
  albumIds: null,
  setScope: (ids) => set({ albumIds: ids }),
  clearScope: () => set({ albumIds: null }),
}));

// -- Selectors (narrow: each returns one primitive or one stable reference) --

export const useExportScope = (): number[] | null => useExportScopeStore((s) => s.albumIds);
export const useSetExportScope = () => useExportScopeStore((s) => s.setScope);
export const useClearExportScope = () => useExportScopeStore((s) => s.clearScope);
