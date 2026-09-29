/*
 * The export scope: everything, or only what changed since the destination's last export. Maps the
 * scope, the target shape and the changed-only preview to the one state the view renders, so the
 * control, the readiness line and the CTA all read the same answer.
 */

// -- Type Imports --
import type { ExportChangeSet } from "../../types";

/** What a run writes: the whole library, or only the files new or changed at the destination. */
export type ExportScope = "all" | "changed";

/**
 * The scope as the view shows it. `snapshotDisabled` is a dated device snapshot, which always holds
 * everything; `pending` is changed-only with no preview in hand yet; `firstExport` is an empty or
 * missing destination, where a changed-only run sends everything.
 */
export type ScopeState =
  | "all"
  | "snapshotDisabled"
  | "pending"
  | "firstExport"
  | "noRecord"
  | "nothingChanged"
  | "everythingChanged"
  | "changes";

/**
 * Resolves the scope state. A record with no stamp reads as no record, since there is no date to
 * measure changes from. Only a destination already holding files can be marked up to date; an empty
 * one has nothing to adopt.
 */
export function scopeState(
  scope: ExportScope,
  changes: ExportChangeSet | null,
  datedSnapshot: boolean,
  destinationNonEmpty: boolean,
): ScopeState {
  if (datedSnapshot) return "snapshotDisabled";
  if (scope === "all") return "all";
  if (!changes) return "pending";
  if (!changes.has_record || changes.last_exported_at == null) {
    return destinationNonEmpty ? "noRecord" : "firstExport";
  }
  if (changes.files === 0) return "nothingChanged";
  if (changes.files === changes.total_files) return "everythingChanged";
  return "changes";
}

/** Whether the readiness line reads the changed counts rather than the whole library. */
export function showsChangedCounts(state: ScopeState): boolean {
  return state === "changes" || state === "everythingChanged" || state === "nothingChanged";
}
