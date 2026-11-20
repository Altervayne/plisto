// -- Utils Imports --
import { formatBytes, formatDuration } from "./format";

// -- Type Imports --
import type { Translate } from "../i18n";
import type { KeptBackup } from "../types";

/** The two lengths of a trim, or null when the row predates them. */
function lengths(backup: KeptBackup): { from: string; to: string } | null {
  if (backup.originalDurationMs == null || backup.trimmedDurationMs == null) return null;
  return {
    from: formatDuration(backup.originalDurationMs / 1000),
    to: formatDuration(backup.trimmedDurationMs / 1000),
  };
}

/** A row's second line: the trim as it went, or the original's size and age when the lengths are unknown. */
export function keptRowMeta(t: Translate, backup: KeptBackup, when: string): string {
  const size = formatBytes(backup.size);
  const span = lengths(backup);
  return span
    ? t((d) => d.fileWrites.kept.rowTrimmed, { ...span, size })
    : t((d) => d.fileWrites.kept.rowMeta, { size, when });
}

/** The body of the Undo trim confirm: the lengths swapped back, or the plain sentence when they are unknown. */
export function keptUndoBody(t: Translate, backup: KeptBackup): string {
  const span = lengths(backup);
  return span ? t((d) => d.fileWrites.kept.undoBodyTimed, span) : t((d) => d.fileWrites.kept.undoBody);
}
