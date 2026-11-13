// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- Component Imports --
import { ScanIssuesSheet } from "./ScanIssuesSheet";

// -- State Imports --
import { useCloseScanIssues, useScanIssuesOpen, useScanIssuesStore } from "../../state/scanIssues";

// -- Type Imports --
import type { ScanIssueRetryProgress } from "../../types";

/**
 * Mounts the unreadable-files sheet while the store flag holds it open, whichever entry opened it. It
 * also listens for retry ticks for the app's life; the store drops any tick that no retry is waiting for.
 */
export function ScanIssuesHost() {
  const open = useScanIssuesOpen();
  const close = useCloseScanIssues();

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    listen<ScanIssueRetryProgress>("scan-issues:retry-progress", (e) =>
      useScanIssuesStore.getState().applyRetryProgress(e.payload),
    )
      .then((fn) => {
        // Unmounted while attaching: drop the listener at once rather than leak it.
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return open ? <ScanIssuesSheet onClose={close} /> : null;
}
