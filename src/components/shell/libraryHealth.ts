/*
 * Why the library is out of sync, for the title bar's status dot. Each reason is a separate entry so
 * the tooltip can word one line per reason; no reasons means the dot reads in sync.
 */

/** One reason the library is not in sync. */
export type HealthReason =
  | { kind: "offline"; rootIds: number[] }
  | { kind: "checkFailed" }
  | { kind: "gone"; n: number };

/** The signals the dot reads: the last scan's unreachable roots, a failed quiet check, gone tracks. */
export interface HealthInput {
  offlineRoots: number[];
  checkFailed: boolean;
  goneCount: number;
}

/** The reasons the library is out of sync, in tooltip order. Empty when everything is in place. */
export function healthReasons({ offlineRoots, checkFailed, goneCount }: HealthInput): HealthReason[] {
  const reasons: HealthReason[] = [];
  if (offlineRoots.length > 0) reasons.push({ kind: "offline", rootIds: offlineRoots });
  if (checkFailed) reasons.push({ kind: "checkFailed" });
  if (goneCount > 0) reasons.push({ kind: "gone", n: goneCount });
  return reasons;
}
