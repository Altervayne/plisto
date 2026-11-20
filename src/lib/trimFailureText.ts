/*
 * A failed trim or Undo trim in words, shared by the Track Editor and Kept backups so one failure reads
 * the same on both.
 */

// -- Utils Imports --
import { driveOf } from "./trimReplace";

// -- Type Imports --
import type { Translate } from "../i18n";
import type { TrimFailureInfo } from "./trimReplace";

/**
 * A failure as a bold lead, when the kind has one, and the line under it. `path` names the drive a
 * no-room failure ran out on; `size` is the kept original, already formatted.
 */
export function trimFailureWords(
  t: Translate,
  failure: TrimFailureInfo,
  path: string,
  size: string,
): { title: string | null; text: string | null } {
  switch (failure.kind) {
    case "locked":
    case "denied":
    case "changed":
    case "offline":
    case "busy":
    case "unavailable": {
      const kind = failure.kind;
      return {
        title: t((d) => d.fileWrites.trim.fail[kind].title),
        text: t((d) => d.fileWrites.trim.fail[kind].text),
      };
    }
    case "inUse":
      return { title: t((d) => d.fileWrites.trim.fail.inUse.title), text: t((d) => d.fileWrites.trim.why.inUse) };
    case "missing":
      return { title: t((d) => d.fileWrites.trim.fail.missing.title), text: t((d) => d.fileWrites.trim.missingLine) };
    case "space":
      return {
        title: t((d) => d.fileWrites.trim.fail.space.title, { drive: driveOf(path) }),
        text: t((d) => d.fileWrites.trim.fail.space.text, { size }),
      };
    case "other":
      return {
        title: t((d) => d.fileWrites.trim.fail.other.title),
        text: failure.code ? t((d) => d.fileWrites.trim.fail.other.text, { code: failure.code }) : null,
      };
    case "fileWrite":
      return { title: null, text: t((d) => d.fileWrites.busy) };
    case "scan":
      return { title: null, text: t((d) => d.scan.issueScanRunning) };
  }
}

/**
 * Why an Undo trim failed, in one line: a changed file, an unavailable replace and a full drive in the
 * undo's own words, any other kind as the trim's line.
 */
export function undoFailureText(t: Translate, failure: TrimFailureInfo, path: string, size: string): string {
  if (failure.kind === "changed") return t((d) => d.fileWrites.trim.undoRefused);
  if (failure.kind === "unavailable") return t((d) => d.fileWrites.trim.undoUnavailable);
  if (failure.kind === "space") return t((d) => d.fileWrites.trim.undoSpace, { size });
  const words = trimFailureWords(t, failure, path, size);
  return words.text ?? words.title ?? "";
}
