/*
 * The wording of each Locate step, and of the remove confirm, as one line, built from the dictionary. Pure, so a test can run every
 * step through both locales. A move's counts are the backend's sample, so the confirm names how many of
 * the checked tracks were found; a merge's and a folder locate's counts are exact.
 */

// -- Utils Imports --
import { isUnfinishedWrites } from "../../lib/busyError";

// -- Type Imports --
import type { Translate } from "../../i18n";
import type { RootRemovalImpact } from "../../types";
import type { LocateRefusal, LocateStep } from "./locateFlow";

/** The trailing folder name of a root path, tolerant of either separator and a trailing slash. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** The line for a refused relocate, folder locate or check. */
export function refusalLine(
  t: Translate,
  reason: LocateRefusal,
  name: string,
  folder: string,
): string {
  switch (reason.code) {
    case "no_match":
      return t((d) => d.settings.locateNoMatch, { name, folder });
    case "same":
      return t((d) => d.settings.locateSame, { name });
    case "overlap":
      return "other" in reason
        ? t((d) => d.settings.locateOverlap, { folder, other: reason.other })
        : t((d) => d.settings.locateFolderOverlap, { name, folder });
    case "nothing_gone":
      return t((d) => d.settings.locateFolderNothingGone, { name });
    case "outside_roots":
      return t((d) => d.settings.locateFolderOutside, { folder });
    case "root_level":
      return t((d) => d.settings.locateFolderRootLevel, { name });
    case "cancelled":
      return t((d) => d.settings.locateFolderCancelled);
    case "unreadable":
      return t((d) => d.settings.locateUnreadable, { folder });
    case "inconclusive":
      return t((d) => d.settings.locateInconclusive, { folder });
    case "failed":
      return isUnfinishedWrites(reason.message)
        ? t((d) => d.settings.locateUnfinished, { name })
        : t((d) => d.settings.locateFailed, { name });
    case "busy":
      return reason.by === "fileWrite" ? t((d) => d.fileWrites.busy) : t((d) => d.settings.locateBusy);
  }
}

/** Whether retrying the same folder can change a refusal, as opposed to picking another one. */
export function retryable(reason: LocateRefusal): boolean {
  return reason.code === "unreadable" || reason.code === "inconclusive";
}

/** The line for a step that has one; the idle and running steps are silent. */
export function stepLine(t: Translate, step: LocateStep): string | null {
  switch (step.kind) {
    case "idle":
    case "running":
      return null;
    case "checking":
      return t((d) => d.settings.locateChecking, { folder: step.folder });
    case "refused":
      return refusalLine(t, step.reason, step.name, step.folder);
    case "done":
      return [
        step.located != null
          ? t((d) => d.settings.locateFolderDone, { n: step.located, name: step.name, folder: step.folder })
          : t((d) => d.settings.locateDone, { name: step.name, folder: step.folder }),
        step.missing > 0 ? t((d) => d.settings.locateDoneMissing, { n: step.missing }) : null,
      ]
        .filter(Boolean)
        .join(" ");
    case "confirm": {
      const { plan, name, folder } = step;
      const lead =
        plan.kind === "merge"
          ? t((d) => d.settings.locateMerge, { n: plan.other_tracks, name, folder })
          : plan.kind === "folder"
            ? t((d) => d.settings.locateFolderConfirm, { n: plan.relinked + plan.merged, total: plan.total, folder })
            : t((d) => d.settings.locateConfirm, { n: plan.matched, total: plan.sampled, folder });
      const folded =
        plan.kind === "folder" && plan.merged > 0
          ? t((d) => d.settings.locateFolderMerged, { n: plan.merged })
          : null;
      const replaced =
        plan.kind !== "move" && plan.albums_replaced > 0
          ? t((d) => d.settings.locateMergeReplaced, { n: plan.albums_replaced })
          : null;
      const partial = plan.partial ? t((d) => d.settings.locatePartial) : null;
      return [lead, folded, replaced, partial].filter(Boolean).join(" ");
    }
  }
}

/**
 * The line of a root's remove confirm. It leads with the question and names the tracks dropped, then
 * adds only the album clauses that bite. A root that may only have moved leads with that instead and
 * counts the playlist entries that go too. The offline lead shows only while the root is offline, so an
 * online root that is merely all gone omits it.
 */
export function removePrompt(
  t: Translate,
  impact: RootRemovalImpact,
  root: { name: string; offline: boolean; eligible: boolean },
): string {
  const parts = root.eligible
    ? [
        root.offline ? t((d) => d.settings.removeOffline, { name: root.name }) : null,
        t((d) => d.settings.removeOfflineDrops, { n: impact.tracks }),
        impact.playlist_entries > 0
          ? t((d) => d.settings.removeOfflineSlots, { n: impact.playlist_entries })
          : null,
      ]
    : [
        t((d) => d.settings.removeConfirm),
        t((d) => d.settings.removeDrops, { n: impact.tracks }),
        impact.albums_losing_members > 0
          ? t((d) => d.settings.removeLosing, { n: impact.albums_losing_members })
          : null,
        impact.albums_emptied > 0
          ? t((d) => d.settings.removeEmptied, { n: impact.albums_emptied })
          : null,
      ];
  return parts.filter(Boolean).join(" ");
}
