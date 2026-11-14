/*
 * The sandbox self-check outcome for this app start: pending until the one run settles. The run starts
 * from the main window's shell only, after boot, and never delays a plugin frame.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { create } from "zustand";

// -- Utils Imports --
import { runSandboxCheck } from "./sandboxCheck";
import { probeOutcome } from "./trust";

// -- Type Imports --
import type { SandboxDeps, SandboxOutcome } from "./sandboxCheck";
import type { ProbeOutcome } from "./trust";

export interface SandboxCheckState {
  outcome: "pending" | SandboxOutcome;
  udp: number;
  tcp: number;
}

export const useSandboxStore = create<SandboxCheckState>(() => ({ outcome: "pending", udp: 0, tcp: 0 }));

let started = false;

/** Runs the check once per app start; later calls resolve at once. */
export async function startSandboxCheck(deps?: SandboxDeps): Promise<void> {
  if (started) return;
  started = true;
  useSandboxStore.setState(await runSandboxCheck(deps));
}

/** Allows another run and clears the outcome. Tests only. */
export function resetSandboxCheck(): void {
  started = false;
  useSandboxStore.setState({ outcome: "pending", udp: 0, tcp: 0 });
}

export const selectProbe = (s: SandboxCheckState): ProbeOutcome => probeOutcome(s.outcome);
export const selectLeaking = (s: SandboxCheckState): boolean => s.outcome === "leaking";

/** The sandbox outcome every plugin tag and review sheet reads; only a detected leak is not_passed. */
export const useProbe = (): ProbeOutcome => useSandboxStore(selectProbe);

/** True when the check found the guard not holding. */
export const useSandboxLeaking = (): boolean => useSandboxStore(selectLeaking);

/** Starts the check once from the main window's shell. Does nothing under the test runner. */
export function useSandboxCheck(): void {
  useEffect(() => {
    if (import.meta.env.MODE === "test") return;
    void startSandboxCheck();
  }, []);
}
