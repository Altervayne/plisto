// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { StaffSpinner } from "../scan/StaffSpinner";

// -- State Imports --
import { useLoadPreferences } from "../../state/preferences/store";

// -- Theme Imports --
import { useApplyTheme } from "../../theme";

// -- IPC Imports --
import { getExportStatus, quitApp, showMainWindow } from "../../lib/ipc";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { ExportProgress, ExportStatus } from "../../types";

// -- Style Imports --
import styles from "./TrayStatus.module.css";

/**
 * The tray popup body: a live mirror of the app-global export status with the Show Plisto and Quit
 * actions. It runs in its own webview, so it hydrates preferences and theme itself, reads the initial
 * status once (the popup can open mid-run), then follows the export events for the rest. Running shows
 * the StaffSpinner and the count; idle a quiet line. The buttons route through Rust commands.
 */
export function TrayStatus() {
  const loadPreferences = useLoadPreferences();
  const t = useT();
  const [status, setStatus] = useState<ExportStatus>({ running: false, progress: null });

  // Hydrate prefs so theme and locale match the main window, then stamp the theme on this root.
  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);
  useApplyTheme();

  // Seed from the current status for a popup opened mid-export, then track the run live.
  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];

    void getExportStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});

    const subscribe = async () => {
      unlisteners.push(
        await listen("export:started", () => setStatus({ running: true, progress: null })),
      );
      unlisteners.push(
        await listen<ExportProgress>("export:progress", (e) =>
          setStatus({ running: true, progress: e.payload }),
        ),
      );
      unlisteners.push(
        await listen("export:finished", () => setStatus({ running: false, progress: null })),
      );
      unlisteners.push(
        await listen("export:failed", () => setStatus({ running: false, progress: null })),
      );
    };
    void subscribe().catch(() => {});

    return () => {
      alive = false;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  const exported = status.progress?.exported ?? 0;
  const total = status.progress?.total ?? 0;
  const errors = status.progress?.errors ?? 0;

  return (
    <div className={styles.popup}>
      <div className={styles.body}>
        {status.running ? (
          <>
            <StaffSpinner />
            <p className={`${styles.line} tabular`}>
              {t((d) => d.tray.exporting, { exported, total })}
            </p>
            {errors > 0 ? (
              <p className={styles.errors}>{t((d) => d.export.errors, { n: errors })}</p>
            ) : null}
          </>
        ) : (
          <p className={styles.idle}>{t((d) => d.tray.idle)}</p>
        )}
      </div>
      <div className={styles.actions}>
        <PrimaryButton onClick={() => void showMainWindow()}>{t((d) => d.tray.show)}</PrimaryButton>
        <QuietButton onClick={() => void quitApp()}>{t((d) => d.tray.quit)}</QuietButton>
      </div>
    </div>
  );
}
