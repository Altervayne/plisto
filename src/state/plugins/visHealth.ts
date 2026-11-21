/*
 * Visualizer frame health, one record per mount key. Kept apart from the page and background frames'
 * health, so a visualizer mounting never resets its plugin's page to loading and a hung or crashed
 * visualizer never shows the page's overlay or crash card. Several mounts of one plugin are independent.
 * Writes that change nothing keep the state, so a per-tick caller never wakes a selector.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Type Imports --
import type { PluginFrameCrashReason } from "../../types";

export type VisPhase = "loading" | "live" | "not_responding" | "crashed";

export interface VisHealth {
  pluginId: string;
  phase: VisPhase;
  /** Set only while the phase is crashed. */
  reason?: PluginFrameCrashReason;
}

interface VisHealthStore {
  /** Per mount key. */
  health: Record<string, VisHealth>;
  /** Starts a mount at loading. A key already held starts over. */
  mount: (mountKey: string, pluginId: string) => void;
  /** Sets a phase other than crashed. A no-op for an unknown key or an unchanged phase. */
  setPhase: (mountKey: string, phase: Exclude<VisPhase, "crashed">) => void;
  /** Records a crash. A no-op for an unknown key. */
  crash: (mountKey: string, reason: PluginFrameCrashReason) => void;
  /** Forgets the mount, crash included: the next mount comes under a new key. */
  unmount: (mountKey: string) => void;
}

export const useVisHealthStore = create<VisHealthStore>((set) => ({
  health: {},
  mount: (mountKey, pluginId) =>
    set((s) => ({ health: { ...s.health, [mountKey]: { pluginId, phase: "loading" } } })),
  setPhase: (mountKey, phase) =>
    set((s) => {
      const rec = s.health[mountKey];
      if (!rec || rec.phase === phase) return s;
      return { health: { ...s.health, [mountKey]: { pluginId: rec.pluginId, phase } } };
    }),
  crash: (mountKey, reason) =>
    set((s) => {
      const rec = s.health[mountKey];
      if (!rec || (rec.phase === "crashed" && rec.reason === reason)) return s;
      return { health: { ...s.health, [mountKey]: { pluginId: rec.pluginId, phase: "crashed", reason } } };
    }),
  unmount: (mountKey) =>
    set((s) => {
      if (!s.health[mountKey]) return s;
      const { [mountKey]: _gone, ...rest } = s.health;
      return { health: rest };
    }),
}));

// -- Selectors --

export const useVisHealth = (mountKey: string): VisHealth | undefined =>
  useVisHealthStore((s) => s.health[mountKey]);
export const useVisPhase = (mountKey: string): VisPhase | undefined =>
  useVisHealthStore((s) => s.health[mountKey]?.phase);
