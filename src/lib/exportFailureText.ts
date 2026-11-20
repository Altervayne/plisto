/*
 * The line an export shows when the backend refuses or loses a run. A refusal because a scan or a write
 * to music files holds the library lock is worded by what holds it; any other failure keeps the generic
 * export wording.
 */

// -- Utils Imports --
import { busyKind } from "./busyError";

// -- Type Imports --
import type { Translate } from "../i18n";

/** The busy wording for a refused export, or null when the rejection is not a busy refusal. */
export function exportBusyText(t: Translate, error: unknown): string | null {
  const busy = busyKind(error);
  if (busy === "fileWrite") return t((d) => d.fileWrites.busy);
  if (busy === "scan") return t((d) => d.settings.locateBusy);
  return null;
}

/** The line for a failed export run; a device run keeps its partial-copy wording. */
export function exportFailureText(t: Translate, error: unknown, device: boolean): string {
  return (
    exportBusyText(t, error) ??
    (device ? t((d) => d.export.deviceTransferFailed) : t((d) => d.export.exportFailed))
  );
}
