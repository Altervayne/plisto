/*
 * Removing gone tracks from the sheet: runs the purge and sorts a rejection into the three the sheet words
 * itself. The backend refuses, and removes nothing, when its restore point could not be saved first; its
 * text is matched here so the sheet shows its own copy in either language rather than the raw message.
 */

// -- Type Imports --
import type { Translate } from "../../i18n";
import type { PurgeSummary } from "../../types";

/** The backend's rejection when the restore point before a purge could not be saved. */
export const NOT_SAVED = "Nothing was removed: a restore point could not be saved first.";
/** The backend's rejection when a scan already holds the lock. */
const SCAN_BUSY = "a scan is already running";

export type RemoveOutcome =
  | { kind: "done"; removed: number }
  | { kind: "failed"; reason: "not_saved" | "busy" | "failed" };

/** Purges `ids` through `purge`. An empty list removes nothing and is a no-op. */
export async function removeGone(
  ids: number[],
  purge: (ids: number[]) => Promise<PurgeSummary>,
): Promise<RemoveOutcome> {
  if (ids.length === 0) return { kind: "done", removed: 0 };
  try {
    const summary = await purge(ids);
    return { kind: "done", removed: summary.removed };
  } catch (e) {
    const text = String(e);
    if (text.includes(NOT_SAVED)) return { kind: "failed", reason: "not_saved" };
    if (text.includes(SCAN_BUSY)) return { kind: "failed", reason: "busy" };
    return { kind: "failed", reason: "failed" };
  }
}

/** The sheet's line for a refused remove. */
export function removeFailureLine(t: Translate, reason: "not_saved" | "busy" | "failed"): string {
  switch (reason) {
    case "not_saved":
      return t((d) => d.gone.notRemoved);
    case "busy":
      return t((d) => d.settings.locateBusy);
    case "failed":
      return t((d) => d.gone.removeFailed);
  }
}
