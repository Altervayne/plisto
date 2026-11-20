// -- Type Imports --
import type { Translate } from "../../i18n";
import type { RecoveryReport } from "../../state/fileWrites/store";

/** The lines a recovery report earns, in the order the user cares: what went back, what finished, what waits, what needs a look. */
export function recoveryLines(t: Translate, report: RecoveryReport): string[] {
  const lines: string[] = [];
  if (report.restored > 0) lines.push(t((d) => d.fileWrites.recovery.restored, { n: report.restored }));
  if (report.finished > 0) lines.push(t((d) => d.fileWrites.recovery.finished, { n: report.finished }));
  if (report.heldOffline > 0) lines.push(t((d) => d.fileWrites.recovery.heldOffline, { n: report.heldOffline }));
  if (report.needsAttention.length > 0) {
    lines.push(t((d) => d.fileWrites.recovery.needsAttention, { n: report.needsAttention.length }));
  }
  return lines;
}
