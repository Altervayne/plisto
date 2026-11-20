// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { PointKind } from "./restorePointModel";

/** What a point is called in a row: the reason, and for an action the existing label of that action. */
export function kindLabel(t: Translate, kind: PointKind): string {
  switch (kind.reason) {
    case "version":
      return t((d) => d.restorePoints.kindVersion, { version: kind.version });
    case "daily":
      return t((d) => d.restorePoints.kindDaily);
    case "restore":
      return t((d) => d.restorePoints.kindRestore);
    case "action": {
      switch (kind.action) {
        case "tags_apply":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.tagAlbums.entry) });
        case "merge_duplicates":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.restorePoints.actionMerge) });
        case "delete_albums":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.restorePoints.actionDeleteAlbums) });
        case "remove_root":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.settings.remove) });
        case "purge":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.tracks.removeGone) });
        case "relocate":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.settings.locate) });
        case "stamp":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.restorePoints.actionStamp) });
        case "stamp_undo":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.restorePoints.actionStampUndo) });
        case "trim_replace":
          return t((d) => d.restorePoints.kindAction, { action: t((d) => d.restorePoints.actionTrimReplace) });
        default:
          return t((d) => d.restorePoints.kindActionOther);
      }
    }
  }
}
