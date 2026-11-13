/*
 * The shell UI store: the one open tool session. A track row deep in any library view opens the
 * splice workbench by setting it here, so no callback threads up through the grid, the peek, and the
 * album pane to reach the shell. The workbench overlays the main region while a session holds;
 * clearing it closes the workbench.
 */

// -- Library Imports --
import { create } from "zustand";

/** The open tool session: which verb the workbench runs, over which track. */
export interface ToolSession {
  verb: "split" | "trim";
  trackId: number;
}

/** Which lens the History destination opens on: the deduped recently-played list, the most-played
 *  ranking, or the raw chronological timeline. The two Home See-all boxes route only to recent/most;
 *  the timeline is reachable through the destination's own toggle. */
export type HistoryLens = "recent" | "most" | "timeline";

interface ShellStore {
  openTool: ToolSession | null;
  setOpenTool: (tool: ToolSession | null) => void;
  // The lens the History destination lands on. A Home See-all sets it before navigating, so the two
  // previews route to their matching lens; the destination seeds its own local lens from it.
  historyLens: HistoryLens;
  setHistoryLens: (lens: HistoryLens) => void;
  // Bumped by a surface outside the shell (the title bar) to land on Settings. A counter, not a flag,
  // so a second request after navigating away still fires.
  settingsRequest: number;
  openSettings: () => void;
  // The possible-duplicates sheet, mounted once in the shell and opened from any entry point.
  duplicatesOpen: boolean;
  openDuplicates: () => void;
  closeDuplicates: () => void;
  // Whether the keyboard shortcuts sheet is up. Settings and the shell's own key both open it.
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  // The route a plugin nav row opened, so a page opened on `plugin:<id>` knows which of its views to
  // land on. Null when the page was opened without one.
  pluginRoute: string | null;
  setPluginRoute: (route: string | null) => void;
  // A plugin's ask to show its own page on a route. A counter like `settingsRequest`, so asking twice
  // for the same page still fires; the shell decides whether the page can show.
  pluginPageRequest: PluginPageRequest | null;
  requestPluginPage: (id: string, route: string | null) => void;
}

/** One request to open a plugin's page; `seq` grows with every request. */
export interface PluginPageRequest {
  id: string;
  route: string | null;
  seq: number;
}

const useShellStore = create<ShellStore>((set) => ({
  openTool: null,
  setOpenTool: (openTool) => set({ openTool }),
  historyLens: "recent",
  setHistoryLens: (historyLens) => set({ historyLens }),
  settingsRequest: 0,
  openSettings: () => set((s) => ({ settingsRequest: s.settingsRequest + 1 })),
  duplicatesOpen: false,
  openDuplicates: () => set({ duplicatesOpen: true }),
  closeDuplicates: () => set({ duplicatesOpen: false }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  pluginRoute: null,
  setPluginRoute: (pluginRoute) => set({ pluginRoute }),
  pluginPageRequest: null,
  requestPluginPage: (id, route) =>
    set((s) => ({ pluginPageRequest: { id, route, seq: (s.pluginPageRequest?.seq ?? 0) + 1 } })),
}));

/** Asks the shell to show a plugin's page, from outside React. */
export function requestPluginPage(id: string, route: string | null): void {
  useShellStore.getState().requestPluginPage(id, route);
}

// -- Selectors (narrow: one value or one stable setter each) --

export const useOpenTool = (): ToolSession | null => useShellStore((s) => s.openTool);
export const useSetOpenTool = (): ((tool: ToolSession | null) => void) =>
  useShellStore((s) => s.setOpenTool);

export const useHistoryLens = (): HistoryLens => useShellStore((s) => s.historyLens);
export const useSetHistoryLens = (): ((lens: HistoryLens) => void) =>
  useShellStore((s) => s.setHistoryLens);

export const useSettingsRequest = (): number => useShellStore((s) => s.settingsRequest);
export const useOpenSettings = (): (() => void) => useShellStore((s) => s.openSettings);

export const useDuplicatesOpen = (): boolean => useShellStore((s) => s.duplicatesOpen);
export const useOpenDuplicates = (): (() => void) => useShellStore((s) => s.openDuplicates);
export const useCloseDuplicates = (): (() => void) => useShellStore((s) => s.closeDuplicates);

export const useShortcutsOpen = (): boolean => useShellStore((s) => s.shortcutsOpen);
export const useSetShortcutsOpen = (): ((open: boolean) => void) =>
  useShellStore((s) => s.setShortcutsOpen);

export const usePluginRoute = (): string | null => useShellStore((s) => s.pluginRoute);
export const useSetPluginRoute = (): ((route: string | null) => void) =>
  useShellStore((s) => s.setPluginRoute);

export const usePluginPageRequest = (): PluginPageRequest | null => useShellStore((s) => s.pluginPageRequest);
export const useRequestPluginPage = (): ((id: string, route: string | null) => void) =>
  useShellStore((s) => s.requestPluginPage);
