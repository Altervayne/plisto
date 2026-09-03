// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- IPC Imports --
import { confirmQuit } from "../../lib/ipc";

// -- Local Imports --
import { joinJobSubjects } from "./quitPrompt";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { Translate } from "../../i18n";

/** Maps a running-job key from the backend to its display name; an unknown key falls back to itself. */
function jobName(key: string, t: Translate): string {
  switch (key) {
    case "scan":
      return t((d: Dict) => d.quitGuard.jobScan);
    case "export":
      return t((d: Dict) => d.quitGuard.jobExport);
    case "splice":
      return t((d: Dict) => d.quitGuard.jobSplice);
    case "playlist_export":
      return t((d: Dict) => d.quitGuard.jobPlaylistExport);
    default:
      return key;
  }
}

/**
 * The quit-guard dialog: listens for `app:confirm-quit`, which the backend emits when a close or a
 * Quit lands while a work-losing job runs. It names the running jobs and offers "Quit anyway" (which
 * cancels them and exits) or "Keep running". Mounted once app-wide so it catches the event on any
 * screen - a scan can be running before the library even opens. A re-emit while it is already open is
 * ignored, so a second Quit never stacks a second dialog.
 */
export function ConfirmQuitDialog() {
  const t = useT();
  const [jobs, setJobs] = useState<string[] | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string[]>("app:confirm-quit", (event) => {
      // Keep the first set while the dialog is open, so a re-emit does not replace or restack it.
      setJobs((prev) => prev ?? event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  if (jobs == null) return null;

  const subject = joinJobSubjects(
    jobs.map((key) => jobName(key, t)),
    t((d) => d.quitGuard.and),
  );

  return (
    <ConfirmDialog
      open
      prompt={t((d) => d.quitGuard.running, { n: jobs.length, subject })}
      confirmLabel={t((d) => d.quitGuard.quitAnyway)}
      cancelLabel={t((d) => d.quitGuard.keepRunning)}
      onConfirm={() => void confirmQuit().catch(() => {})}
      onClose={() => setJobs(null)}
      destructive
    />
  );
}
