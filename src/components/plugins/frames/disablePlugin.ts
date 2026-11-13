/*
 * Turns a plugin off from a frame surface (the not-responding overlay or the crash card). The returned row
 * replaces the store's copy, so the rail and the page follow at once. A refusal is logged and leaves the
 * surface where it is.
 */

// -- IPC Imports --
import { pluginDisable } from "../../../lib/ipc";

// -- State Imports --
import { logInstallError } from "../../../state/plugins/errors";
import { usePluginsStore } from "../../../state/plugins/store";

export function disablePlugin(id: string): void {
  pluginDisable(id)
    .then((row) => usePluginsStore.getState().upsertRow(row))
    .catch((e) => {
      logInstallError("disable", e);
    });
}
