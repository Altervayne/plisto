/*
 * The hidden-window export notifier. Mounted in the main window, which keeps running while hidden to
 * tray, it fires a localized OS notification when an export finishes or fails AND the main window is
 * out of sight - so a background export reports its outcome without stealing focus. A visible window
 * gets nothing; the export view already shows the result there.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// -- Window Imports --
import { isWindowVisible } from "../lib/appWindow";

// -- i18n Imports --
import { useT } from "../i18n";

// -- Type Imports --
import type { ExportSummary } from "../types";

/** Sends `title`/`body` as an OS notification, requesting permission on first need. No-op when denied. */
async function notify(title: string, body: string): Promise<void> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
}

/** Subscribes to the export terminal events and notifies only while the main window is hidden. */
export function useExportNotifications(): void {
  const t = useT();

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const notifyIfHidden = async (title: string, body: string) => {
      if (await isWindowVisible()) return;
      await notify(title, body);
    };

    const subscribe = async () => {
      unlisteners.push(
        await listen<ExportSummary>("export:finished", (e) => {
          void notifyIfHidden(
            t((d) => d.notify.finishedTitle),
            t((d) => d.notify.finishedBody, { n: e.payload.exported }),
          );
        }),
      );
      unlisteners.push(
        await listen("export:failed", () => {
          void notifyIfHidden(
            t((d) => d.notify.failedTitle),
            t((d) => d.notify.failedBody),
          );
        }),
      );
    };
    void subscribe().catch(() => {});

    return () => {
      unlisteners.forEach((fn) => fn());
    };
  }, [t]);
}
