// -- Type Imports --
import type { DestinationCheck } from "../../types";

/** Why the run button is disabled, one entry per unmet condition. */
export type RunBlocker = "noDestination" | "checking" | "unchecked" | "invalidDestination" | "gate";

/**
 * The unmet run conditions, in the order the user should fix them: no folder, a check still in flight,
 * a folder whose check failed, a folder the check refused, then the body's own gate (segments to split,
 * a range to trim). Empty when the run is ready. A refused folder or a pending check is listed so the
 * button stays disabled, but neither needs a reason line.
 */
export function runBlockers(
  destination: string | null,
  check: DestinationCheck | null,
  checking: boolean,
  gateMet: boolean,
): RunBlocker[] {
  const blockers: RunBlocker[] = [];
  if (!destination) blockers.push("noDestination");
  else if (checking) blockers.push("checking");
  else if (!check) blockers.push("unchecked");
  else if (!check.ok) blockers.push("invalidDestination");
  if (!gateMet) blockers.push("gate");
  return blockers;
}
