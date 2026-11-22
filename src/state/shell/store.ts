/*
 * The shell UI store: the one open tool session. A track row deep in any library view opens the
 * splice workbench by setting it here, so no callback threads up through the grid, the peek, and the
 * album pane to reach the shell. The workbench overlays the main region while a session holds;
 * clearing it closes the workbench.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { ALL_GONE } from "../gone/goneGroups";
import { usePluginsStore } from "../plugins/store";

// -- Utils Imports --
import { listingOf } from "../../components/shell/navVisibility";
import { hubSettingId } from "../../components/settings/settingsRegistry";
import { familySettingId, sectionForTarget } from "../../components/settings/settingsTarget";

// -- Type Imports --
import type { GoneScope } from "../gone/goneGroups";
import type { SettingsSectionId } from "../../components/settings/settingsSections";
import type { SettingsTarget } from "../../components/settings/settingsTarget";

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
  // The Settings section on show. Kept for the session so Settings reopens where it was left; a target
  // changes it, nothing else does.
  settingsSection: SettingsSectionId;
  setSettingsSection: (id: SettingsSectionId) => void;
  // Opens Settings, optionally on a row or section. A plain open drops any target still waiting.
  openSettings: (opts?: OpenSettingsOptions) => void;
  // The target waiting for Settings to land on it, held until Settings takes it. `seq` is the request
  // that set it, so asking for the same target again while Settings shows still lands again.
  settingsTarget: PendingSettingsTarget | null;
  takeSettingsTarget: () => SettingsTarget | null;
  // The possible-duplicates sheet, mounted once in the shell and opened from any entry point.
  duplicatesOpen: boolean;
  openDuplicates: () => void;
  closeDuplicates: () => void;
  // The gone-tracks sheet and the scope it opened on, mounted once in the shell. Opening always sets the scope.
  goneOpen: boolean;
  goneScope: GoneScope;
  openGone: (scope?: GoneScope) => void;
  closeGone: () => void;
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
  // The hub row a surface outside Settings asked to land on. Settings opens it once and clears it.
  pluginHubFocus: string | null;
  // The catalog family to unfold; separate from the hub row's focus so only the surface asked for opens.
  pluginFamilyFocus: string | null;
  openPluginHub: (id: string) => void;
  openPluginFamily: (id: string) => void;
  clearPluginHubFocus: () => void;
  clearPluginFamilyFocus: () => void;
}

export interface OpenSettingsOptions {
  target?: SettingsTarget;
}

/** A Settings target held until consumed. */
export interface PendingSettingsTarget {
  target: SettingsTarget;
  seq: number;
}

/** One request to open a plugin's page; `seq` grows with every request. */
export interface PluginPageRequest {
  id: string;
  route: string | null;
  seq: number;
}

const useShellStore = create<ShellStore>((set, get) => ({
  openTool: null,
  setOpenTool: (openTool) => set({ openTool }),
  historyLens: "recent",
  setHistoryLens: (historyLens) => set({ historyLens }),
  settingsRequest: 0,
  settingsSection: "folders",
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  openSettings: (opts) =>
    set((s) => ({
      settingsRequest: s.settingsRequest + 1,
      settingsTarget: opts?.target ? { target: opts.target, seq: s.settingsRequest + 1 } : null,
      settingsSection: (opts?.target && sectionForTarget(opts.target)) || s.settingsSection,
    })),
  settingsTarget: null,
  takeSettingsTarget: () => {
    const pending = get().settingsTarget;
    if (pending) set({ settingsTarget: null });
    return pending?.target ?? null;
  },
  duplicatesOpen: false,
  openDuplicates: () => set({ duplicatesOpen: true }),
  closeDuplicates: () => set({ duplicatesOpen: false }),
  goneOpen: false,
  goneScope: ALL_GONE,
  openGone: (scope = ALL_GONE) => set({ goneOpen: true, goneScope: scope }),
  closeGone: () => set({ goneOpen: false }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  pluginRoute: null,
  setPluginRoute: (pluginRoute) => set({ pluginRoute }),
  pluginPageRequest: null,
  requestPluginPage: (id, route) =>
    set((s) => ({ pluginPageRequest: { id, route, seq: (s.pluginPageRequest?.seq ?? 0) + 1 } })),
  pluginHubFocus: null,
  pluginFamilyFocus: null,
  openPluginFamily: (id) =>
    set((s) => {
      const seq = s.settingsRequest + 1;
      return {
        pluginFamilyFocus: id,
        settingsRequest: seq,
        settingsTarget: { target: familySettingId(id), seq },
        settingsSection: "visualizers" as const,
      };
    }),
  openPluginHub: (id) =>
    set((s) => {
      const row = usePluginsStore.getState().rows.find((r) => r.id === id);
      const seq = s.settingsRequest + 1;
      if (row && listingOf(row) === "catalog") {
        return {
          pluginHubFocus: null,
          pluginFamilyFocus: id,
          settingsRequest: seq,
          settingsTarget: { target: familySettingId(id), seq },
          settingsSection: "visualizers" as const,
        };
      }
      return {
        pluginHubFocus: id,
        pluginFamilyFocus: null,
        settingsRequest: seq,
        settingsTarget: { target: hubSettingId(id), seq },
        settingsSection: "plugins" as const,
      };
    }),
  clearPluginHubFocus: () => set({ pluginHubFocus: null }),
  clearPluginFamilyFocus: () => set({ pluginFamilyFocus: null }),
}));

/**
 * Opens Settings where a plugin is managed: its hub row under Plugins, or its family under Visualizers
 * for a plugin the catalog lists. An id with no row opens the hub row.
 */
export function openPluginHub(id: string): void {
  useShellStore.getState().openPluginHub(id);
}

/** Opens Settings on a plugin's family under Visualizers, unfolded. */
export function openPluginFamily(id: string): void {
  useShellStore.getState().openPluginFamily(id);
}

/** Opens Settings, optionally on a target, from outside React. */
export function openSettings(opts?: OpenSettingsOptions): void {
  useShellStore.getState().openSettings(opts);
}

/** Hands the waiting Settings target to its one consumer and clears it. */
export function takeSettingsTarget(): SettingsTarget | null {
  return useShellStore.getState().takeSettingsTarget();
}

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
export const useOpenSettings = (): ((opts?: OpenSettingsOptions) => void) =>
  useShellStore((s) => s.openSettings);
export const usePendingSettingsTarget = (): PendingSettingsTarget | null =>
  useShellStore((s) => s.settingsTarget);
export const useSettingsSection = (): SettingsSectionId => useShellStore((s) => s.settingsSection);
export const useSetSettingsSection = (): ((id: SettingsSectionId) => void) =>
  useShellStore((s) => s.setSettingsSection);

/** The Settings section last shown, from outside React. */
export function settingsSection(): SettingsSectionId {
  return useShellStore.getState().settingsSection;
}

export const useDuplicatesOpen = (): boolean => useShellStore((s) => s.duplicatesOpen);
export const useOpenDuplicates = (): (() => void) => useShellStore((s) => s.openDuplicates);
export const useCloseDuplicates = (): (() => void) => useShellStore((s) => s.closeDuplicates);

export const useGoneOpen = (): boolean => useShellStore((s) => s.goneOpen);
export const useGoneScope = (): GoneScope => useShellStore((s) => s.goneScope);
export const useOpenGone = (): ((scope?: GoneScope) => void) => useShellStore((s) => s.openGone);
export const useCloseGone = (): (() => void) => useShellStore((s) => s.closeGone);

export const useShortcutsOpen = (): boolean => useShellStore((s) => s.shortcutsOpen);
export const useSetShortcutsOpen = (): ((open: boolean) => void) =>
  useShellStore((s) => s.setShortcutsOpen);

export const usePluginRoute = (): string | null => useShellStore((s) => s.pluginRoute);
export const useSetPluginRoute = (): ((route: string | null) => void) =>
  useShellStore((s) => s.setPluginRoute);

export const usePluginPageRequest = (): PluginPageRequest | null => useShellStore((s) => s.pluginPageRequest);
export const useRequestPluginPage = (): ((id: string, route: string | null) => void) =>
  useShellStore((s) => s.requestPluginPage);

export const usePluginHubFocus = (): string | null => useShellStore((s) => s.pluginHubFocus);
export const useClearPluginHubFocus = (): (() => void) => useShellStore((s) => s.clearPluginHubFocus);
export const usePluginFamilyFocus = (): string | null => useShellStore((s) => s.pluginFamilyFocus);
export const useClearPluginFamilyFocus = (): (() => void) =>
  useShellStore((s) => s.clearPluginFamilyFocus);
