/*
 * Where loudness levelling stands, derived from the coverage buckets, the levelling switch, and whether a
 * scan holds the worker back. Pure, so the Settings block only picks wording per state.
 */

// -- Type Imports --
import type { LoudnessCoverage } from "../../types";

export type CoverageState =
  | "off"
  | "loading"
  | "empty"
  | "measuring"
  | "paused"
  | "complete"
  | "nothingToMeasure";

/**
 * Off wins over everything. With levelling on: no coverage yet is loading, no tracks is empty, pending
 * tracks are measuring (paused while a scan runs), and a finished library is nothing-to-measure when
 * tags covered every track, else complete.
 */
export function deriveCoverageState(
  on: boolean,
  scanning: boolean,
  coverage: LoudnessCoverage | null,
): CoverageState {
  if (!on) return "off";
  if (coverage == null) return "loading";
  if (coverage.total === 0) return "empty";
  if (coverage.pending > 0) return scanning ? "paused" : "measuring";
  return coverage.measured + coverage.unmeasurable === 0 ? "nothingToMeasure" : "complete";
}

/** The measuring progress: tracks done and the run's size (done plus still pending). */
export function measuringProgress(coverage: LoudnessCoverage): { done: number; of: number } {
  return { done: coverage.measured, of: coverage.measured + coverage.pending };
}
