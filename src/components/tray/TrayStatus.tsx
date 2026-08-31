// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { StaffSpinner } from "../scan/StaffSpinner";
import { PopOutButton } from "../player/PopOutButton";
import { Transport } from "../player/Transport";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { useTrackDisplay } from "../player/useTrackDisplay";

// -- State Imports --
import { useLoadPreferences } from "../../state/preferences/store";
import { useCurrentTrackId, usePlayerSync } from "../../state/player/store";

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

  // Seed and follow the playback snapshot in this webview too, so the now-playing block names the
  // current track without the main window's library store.
  usePlayerSync();
  const trackId = useCurrentTrackId();

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
      {trackId != null ? <TrayNowPlaying trackId={trackId} /> : null}
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

/**
 * The now-playing block: the current track's cover and one text line over the transport. It reads the
 * cover and display fields by id, so it only mounts with a real track id - the id-typed hooks never
 * run with a null id. Both reads work in this satellite webview: the cover through pure IPC, the
 * title/artist through the by-id display command.
 */
function TrayNowPlaying({ trackId }: { trackId: number }) {
  const { cover } = useTrackCover(trackId);
  const { title, artist } = useTrackDisplay(trackId);
  const t = useT();

  return (
    <div className={styles.nowBlock}>
      <div className={styles.nowRow}>
        <span className={styles.cover}>
          <Cover src={cover?.src ?? null} alt="" />
        </span>
        <span className={styles.text}>
          <span className={styles.title}>{title ?? t((d) => d.albums.untitled)}</span>
          <span className={styles.artist}>{artist ?? t((d) => d.albums.unknownArtist)}</span>
        </span>
        <span className={styles.summon}>
          <PopOutButton />
        </span>
      </div>
      <Transport />
    </div>
  );
}
