/*
 * Typed wrappers for the debug-only probe commands. They are kept apart from lib/ipc.ts so nothing
 * outside the probes page can reach them; the page is the only importer.
 */

// -- Library Imports --
import { invoke } from "@tauri-apps/api/core";

export interface ProbeProcess {
  pid: number;
  kind: string;
  /** Scheme plus host of each frame the process serves, nothing more. */
  hosts: string[];
}

export interface ProbeProcesses {
  browser_version: string;
  processes: ProbeProcess[];
}

export interface ProbeCpu {
  pid: number;
  percent_of_one_core: number;
}

export interface ProbeMemory {
  pid: number;
  working_set: number;
  private_bytes: number;
}

export interface BurstStats {
  count: number;
  median_us: number;
  p99_us: number;
  max_us: number;
}

/** A PNG of the main webview. `save` also writes it under the temp folder. */
export function probeCapture(save: boolean): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("probe_capture", { save });
}

export function probeProcesses(): Promise<ProbeProcesses> {
  return invoke<ProbeProcesses>("probe_processes");
}

export function probeCpu(pids: number[], windowMs: number): Promise<ProbeCpu[]> {
  return invoke<ProbeCpu[]>("probe_cpu", { pids, windowMs });
}

export function probeMemory(pids: number[]): Promise<ProbeMemory[]> {
  return invoke<ProbeMemory[]>("probe_memory", { pids });
}

/** Ends one frame process; the host refuses anything but a probe frame's renderer. */
export function probeTerminate(pid: number): Promise<void> {
  return invoke<void>("probe_terminate", { pid });
}

/** Ends the GPU process and resolves with its pid. */
export function probeGpuCrash(): Promise<number> {
  return invoke<number>("probe_gpu_crash");
}

/** Emits `probe:burst` events to the main window and resolves with the sending-side timings. */
export function probeEmitBurst(hz: number, bytes: number, secs: number): Promise<BurstStats> {
  return invoke<BurstStats>("probe_emit_burst", { hz, bytes, secs });
}

/** The probe host's last request lines. */
export function probeHostLog(): Promise<string[]> {
  return invoke<string[]>("probe_host_log");
}
