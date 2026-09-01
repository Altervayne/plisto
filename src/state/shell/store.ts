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

interface ShellStore {
  openTool: ToolSession | null;
  setOpenTool: (tool: ToolSession | null) => void;
}

const useShellStore = create<ShellStore>((set) => ({
  openTool: null,
  setOpenTool: (openTool) => set({ openTool }),
}));

// -- Selectors (narrow: the session, and the stable setter) --

export const useOpenTool = (): ToolSession | null => useShellStore((s) => s.openTool);
export const useSetOpenTool = (): ((tool: ToolSession | null) => void) =>
  useShellStore((s) => s.setOpenTool);
