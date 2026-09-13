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

/** Which lens the History destination opens on: the recently-played list or the most-played ranking. */
export type HistoryLens = "recent" | "most";

interface ShellStore {
  openTool: ToolSession | null;
  setOpenTool: (tool: ToolSession | null) => void;
  // The lens the History destination lands on. A Home See-all sets it before navigating, so the two
  // previews route to their matching lens; the destination seeds its own local lens from it.
  historyLens: HistoryLens;
  setHistoryLens: (lens: HistoryLens) => void;
}

const useShellStore = create<ShellStore>((set) => ({
  openTool: null,
  setOpenTool: (openTool) => set({ openTool }),
  historyLens: "recent",
  setHistoryLens: (historyLens) => set({ historyLens }),
}));

// -- Selectors (narrow: the session, the history lens, and their stable setters) --

export const useOpenTool = (): ToolSession | null => useShellStore((s) => s.openTool);
export const useSetOpenTool = (): ((tool: ToolSession | null) => void) =>
  useShellStore((s) => s.setOpenTool);

export const useHistoryLens = (): HistoryLens => useShellStore((s) => s.historyLens);
export const useSetHistoryLens = (): ((lens: HistoryLens) => void) =>
  useShellStore((s) => s.setHistoryLens);
