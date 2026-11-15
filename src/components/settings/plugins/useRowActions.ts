/*
 * The commands a hub row starts without a sheet: turn a plugin on or off, uninstall it, reload it from
 * its source, and the developer-mode switch. Each returns its result to the store at once, so the list
 * does not wait for the change event. A refusal becomes a message line; an enable that finds the manifest
 * changed reopens the review instead, and so does a reload that asks for different permissions.
 */

// -- Framework Imports --
import { useState } from "react";

// -- State Imports --
import { usePluginsStore } from "../../../state/plugins/store";
import { reloadPlugins } from "../../../state/plugins/usePluginsSync";
import { dropInstalledIcons } from "../../../state/plugins/iconCache";
import { afterUpdate, previousFromRow, reopensReview } from "../../../state/plugins/review";
import { logInstallError } from "../../../state/plugins/errors";

// -- IPC Imports --
import { pluginDisable, pluginEnable, pluginReload, pluginSetDevMode, pluginUninstall } from "../../../lib/ipc";

// -- Type Imports --
import type { OperationLock } from "../../../state/plugins/operationLock";
import type { ReviewLead, ReviewPrevious } from "../../../state/plugins/review";
import type { PluginErrorKey } from "../../../state/plugins/errors";
import type { PluginRow } from "../../../types";

/** A line under the list about the last row command. */
export type RowMessage =
  | { kind: "error"; name: string; error: PluginErrorKey }
  | { kind: "dataWarning"; name: string }
  | { kind: "devFailed"; error: PluginErrorKey };

export interface RowActions {
  message: RowMessage | null;
  dismiss: () => void;
  setEnabled: (row: PluginRow, on: boolean) => Promise<void>;
  uninstall: (row: PluginRow, deleteData: boolean) => Promise<void>;
  /** Re-installs the plugin from its remembered source, as an update. */
  reload: (row: PluginRow) => Promise<void>;
  setDevMode: (on: boolean) => Promise<void>;
}

const nameOf = (row: PluginRow): string => row.manifest?.name ?? row.id;

export function useRowActions(
  lock: OperationLock,
  openReview: (row: PluginRow, previous?: ReviewPrevious | null, lead?: ReviewLead) => boolean,
): RowActions {
  const [message, setMessage] = useState<RowMessage | null>(null);
  const store = () => usePluginsStore.getState();

  const fail = (row: PluginRow, what: string, e: unknown) =>
    setMessage({ kind: "error", name: nameOf(row), error: logInstallError(what, e) });

  const setEnabled = async (row: PluginRow, on: boolean) => {
    await lock.run(async () => {
      setMessage(null);
      try {
        const next = on
          ? await pluginEnable(row.id, undefined, undefined, row.manifest_hash)
          : await pluginDisable(row.id);
        store().upsertRow(next);
      } catch (e) {
        const key = logInstallError(on ? "enable" : "disable", e);
        if (!on || !reopensReview(key)) {
          setMessage({ kind: "error", name: nameOf(row), error: key });
          return;
        }
        // The plugin changed since it was approved: review the manifest as it is now, never the old one.
        const loaded = await reloadPlugins();
        const fresh = store().rows.find((r) => r.id === row.id);
        if (!loaded || (fresh && fresh.state === "needs_consent" && !openReview(fresh, null, "changed"))) {
          setMessage({ kind: "error", name: nameOf(row), error: "unknown" });
        }
      }
    });
  };

  const uninstall = async (row: PluginRow, deleteData: boolean) => {
    await lock.run(async () => {
      setMessage(null);
      try {
        const done = await pluginUninstall(row.id, deleteData);
        store().removeRow(row.id);
        dropInstalledIcons(row.id);
        if (done.data_warning) {
          console.warn(`plugin uninstall left saved data: ${done.data_warning}`);
          setMessage({ kind: "dataWarning", name: nameOf(row) });
        }
      } catch (e) {
        fail(row, "uninstall", e);
      }
    });
  };

  const reload = async (row: PluginRow) => {
    await lock.run(async () => {
      setMessage(null);
      try {
        const done = await pluginReload(row.id);
        dropInstalledIcons(row.id);
        store().upsertRow(done.row);
        if (afterUpdate(done) !== "consent") return;
        // Different permissions: the same review an update opens.
        if (!openReview(done.row, previousFromRow(row, done.previous_version), "updated")) {
          setMessage({ kind: "error", name: nameOf(row), error: "unknown" });
        }
      } catch (e) {
        fail(row, "reload", e);
      }
    });
  };

  const setDevMode = async (on: boolean) => {
    await lock.run(async () => {
      setMessage(null);
      try {
        store().applyDevMode(await pluginSetDevMode(on));
      } catch (e) {
        setMessage({ kind: "devFailed", error: logInstallError("developer mode", e) });
      }
    });
  };

  return { message, dismiss: () => setMessage(null), setEnabled, uninstall, reload, setDevMode };
}
