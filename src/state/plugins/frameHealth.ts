/*
 * Frame health: where each plugin's frame stands, which frames crashed and how often each was restarted.
 * The crash set and the generations feed `wantedFrames` directly, so a crash unmounts a frame and a
 * restart mounts a fresh one under a new key. Every crash goes through `crash`, the one place a crash is
 * recorded. Writes that change nothing keep the state, so a per-tick caller never wakes a selector.
 */

// -- Library Imports --
import { create } from "zustand";

// -- Type Imports --
import type { FramePhase } from "./frameModel";

export type FrameCrashReason = "silent" | "navigated" | "init";

export interface FrameHealth {
  phase: FramePhase;
  /** Set only while the phase is crashed. */
  reason?: FrameCrashReason;
}

interface FrameHealthStore {
  /** Per plugin id. */
  health: Record<string, FrameHealth>;
  /** Crash keys (`id|version|manifest_hash`) of frames that crashed and were not restarted. */
  crashed: ReadonlySet<string>;
  /** Restart count per plugin id. */
  generation: Record<string, number>;
  /** Sets a phase other than crashed. A no-op when the phase is unchanged. */
  setPhase: (id: string, phase: Exclude<FramePhase, "crashed">) => void;
  crash: (id: string, key: string, reason: FrameCrashReason) => void;
  /** Forgets the plugin's phase once its frame is gone. A crash stays until Restart. */
  release: (id: string) => void;
  /** Clears the plugin's crash and bumps its generation, so the next mount is a fresh frame. */
  restart: (id: string) => void;
  /** Drops everything held for plugins outside `liveIds`. */
  prune: (liveIds: ReadonlySet<string>) => void;
}

const ownsKey = (id: string, key: string) => key.startsWith(`${id}|`);

export const useFrameHealthStore = create<FrameHealthStore>((set) => ({
  health: {},
  crashed: new Set(),
  generation: {},
  setPhase: (id, phase) =>
    set((s) => (s.health[id]?.phase === phase ? s : { health: { ...s.health, [id]: { phase } } })),
  crash: (id, key, reason) =>
    set((s) => {
      const same = s.health[id]?.phase === "crashed" && s.health[id]?.reason === reason;
      if (same && s.crashed.has(key)) return s;
      return {
        health: same ? s.health : { ...s.health, [id]: { phase: "crashed", reason } },
        crashed: s.crashed.has(key) ? s.crashed : new Set([...s.crashed, key]),
      };
    }),
  release: (id) =>
    set((s) => {
      if (!s.health[id] || s.health[id].phase === "crashed") return s;
      const { [id]: _gone, ...rest } = s.health;
      return { health: rest };
    }),
  restart: (id) =>
    set((s) => ({
      health: { ...s.health, [id]: { phase: "loading" } },
      crashed: new Set([...s.crashed].filter((key) => !ownsKey(id, key))),
      generation: { ...s.generation, [id]: (s.generation[id] ?? 0) + 1 },
    })),
  prune: (liveIds) =>
    set((s) => {
      const keep = <T>(rec: Record<string, T>) => Object.keys(rec).every((id) => liveIds.has(id));
      const filter = <T>(rec: Record<string, T>) =>
        keep(rec) ? rec : Object.fromEntries(Object.entries(rec).filter(([id]) => liveIds.has(id)));
      const crashed = [...s.crashed].filter((key) => liveIds.has(key.slice(0, key.indexOf("|"))));
      const health = filter(s.health);
      const generation = filter(s.generation);
      const crashedSame = crashed.length === s.crashed.size;
      if (health === s.health && generation === s.generation && crashedSame) return s;
      return { health, generation, crashed: crashedSame ? s.crashed : new Set(crashed) };
    }),
}));

// -- Selectors --

export const useFrameHealth = (id: string): FrameHealth | undefined =>
  useFrameHealthStore((s) => s.health[id]);
export const useFramePhase = (id: string): FramePhase | undefined =>
  useFrameHealthStore((s) => s.health[id]?.phase);
