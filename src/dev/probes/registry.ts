/*
 * Discovers the probe modules: every probes/p*.ts file that exports `probe`. A catalog entry with no
 * module reads as not built; adding a probe is adding its file, with no edit here.
 */

// -- Type Imports --
import type { ProbeModule } from "./types";

/** Maps module id to module. A file without a `probe` export, or a second module for an id, is ignored. */
export function collectProbes(files: Record<string, unknown>): Map<string, ProbeModule> {
  const found = new Map<string, ProbeModule>();
  for (const path of Object.keys(files).sort()) {
    const probe = (files[path] as { probe?: ProbeModule } | undefined)?.probe;
    if (probe && typeof probe.id === "string" && typeof probe.run === "function" && !found.has(probe.id)) {
      found.set(probe.id, probe);
    }
  }
  return found;
}

export const PROBES = collectProbes(
  import.meta.glob(["./probes/p*.ts", "!./probes/*.test.ts"], { eager: true }),
);
