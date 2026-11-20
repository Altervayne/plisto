// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { RestoreFailure } from "../../../state/restorePoints/store";

/** The reason a restore or its dry run did not go ahead, worded for the active language. */
export function failureText(t: Translate, failure: RestoreFailure): string {
  switch (failure.key) {
    case "file_write":
      return t((d) => d.fileWrites.busy);
    case "newer":
      return t((d) => d.restorePoints.failNewer, { format: failure.detail ?? "" });
    case "unreadable":
      return t((d) => d.restorePoints.failUnreadable);
    case "integrity":
      return t((d) => d.restorePoints.failIntegrity);
    case "before_point":
      return t((d) => d.restorePoints.failBeforePoint);
    case "busy":
      return t((d) => d.settings.locateBusy);
    default:
      return t((d) => d.restorePoints.failFailed);
  }
}
