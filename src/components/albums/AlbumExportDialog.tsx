// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { ExportDestination } from "../export/ExportDestination";
import { ExportLayout } from "../export/ExportLayout";
import { ExportReport } from "../export/ExportReport";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- IPC Imports --
import {
  cancelExport,
  createExportChannel,
  exportLibrary,
  validateExportDestination,
} from "../../lib/ipc";

// -- Utils Imports --
import { pickFolder } from "../../lib/dialog";
import { openFolder } from "../../lib/opener";

// -- Local Imports --
import { DEFAULT_PRESET, presetIdFor } from "../export/templates";

// -- Type Imports --
import type { DestinationCheck, ExportProgress, ExportSummary } from "../../types";
import type { ExportPreset } from "../export/templates";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumExportDialog.module.css";

/** Which screen the dialog shows: the destination pick, the live run, then the report. */
type Phase = "idle" | "running" | "done";

/**
 * The selection export modal, a dimmed portal over a set of picked albums or singles. It runs exactly the
 * ids handed in - no Include controls, no scope handoff to the Export screen. Idle pairs the destination
 * control with the same guards the library export uses: a folder inside the workspace is refused, a
 * non-empty one takes a two-step confirm. The same layout template picker the Export screen carries sits
 * here too, editing the shared global patterns. Running streams progress with a cancel; done shows the
 * report over an Open. It
 * dismisses on Escape, a backdrop press, or the close button - never mid-run, so a copy is not abandoned.
 */
export function AlbumExportDialog({
  albumIds,
  onClose,
}: {
  albumIds: number[];
  onClose: () => void;
}) {
  const t = useT();

  const [phase, setPhase] = useState<Phase>("idle");
  const [destination, setDestination] = useState<string | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [confirming, setConfirming] = useState(false);

  const running = phase === "running";

  // The template is the two persisted album patterns, shared with the Export screen; absent, the
  // Artist/Album default stands in. An empty folder is a real value (the Flat preset), so only a missing
  // key falls to the default.
  const folder = usePreference(PREF_KEYS.exportFolderPattern) ?? DEFAULT_PRESET.folder;
  const file = usePreference(PREF_KEYS.exportFilePattern) ?? DEFAULT_PRESET.file;

  const setPreference = useSetPreference();
  // Custom mode is a UI intent: the picker holds Custom even while its patterns still spell a preset, so
  // the fields stay open until the user leaves them. The persisted patterns remain the source of truth.
  const [customMode, setCustomMode] = useState(false);
  const derivedId = presetIdFor(folder, file);
  const selectedPreset = customMode || derivedId === null ? "custom" : derivedId;

  const onSelectPreset = useCallback(
    (preset: ExportPreset) => {
      setCustomMode(false);
      setPreference(PREF_KEYS.exportFolderPattern, preset.folder);
      setPreference(PREF_KEYS.exportFilePattern, preset.file);
    },
    [setPreference],
  );

  const onCustomPatterns = useCallback(
    (nextFolder: string, nextFile: string) => {
      setPreference(PREF_KEYS.exportFolderPattern, nextFolder);
      setPreference(PREF_KEYS.exportFilePattern, nextFile);
    },
    [setPreference],
  );

  // Escape dismisses, matching the backdrop and close button, but stays off during a run.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const onPick = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setDestination(picked);
    setConfirming(false);
    try {
      setCheck(await validateExportDestination(picked));
    } catch {
      setCheck(null);
    }
  }, []);

  const runExport = useCallback(async () => {
    if (!destination) return;
    setConfirming(false);
    setProgress(null);
    setSummary(null);
    setPhase("running");

    const channel = createExportChannel((tick) => {
      // exported is monotonic on the backend; guard an out-of-order tick from regressing it.
      setProgress((prev) => {
        const exported = prev ? Math.max(prev.exported, tick.exported) : tick.exported;
        return { ...tick, exported };
      });
    });

    try {
      setSummary(await exportLibrary(destination, channel, folder, file, { albumIds }));
      setPhase("done");
    } catch {
      // A destination that went invalid mid-run drops back to the pick; the source is untouched.
      setPhase("idle");
    }
  }, [destination, folder, file, albumIds]);

  // A non-empty destination arms a two-step confirm; otherwise the click runs straight away.
  const onExport = useCallback(() => {
    if (check?.non_empty) {
      setConfirming(true);
      return;
    }
    void runExport();
  }, [check, runExport]);

  const canExport = !!destination && !!check?.ok && albumIds.length > 0;

  const total = progress?.total ?? 0;
  const exported = progress?.exported ?? 0;
  const errors = progress?.errors ?? 0;
  const value = total > 0 ? exported / total : null;

  return createPortal(
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={running ? undefined : onClose} aria-hidden="true" />

      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t((d) => d.albums.exportDialogTitle)}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{t((d) => d.albums.exportDialogTitle)}</h2>
            <span className={styles.count}>
              {t((d) => d.albums.gridSelected, { n: albumIds.length })}
            </span>
          </div>
          {!running ? (
            <QuietButton onClick={onClose} aria-label={t((d) => d.common.close)}>
              {t((d) => d.common.close)}
            </QuietButton>
          ) : null}
        </div>

        {phase === "running" ? (
          <div className={styles.run}>
            {destination ? (
              <Tooltip label={destination}>
                <p className={styles.path}>{destination}</p>
              </Tooltip>
            ) : null}
            <ProgressLine value={value} />
            <div className={`${styles.counters} tabular`}>
              <span>
                {exported} / {total}
              </span>
              {errors > 0 ? (
                <span className={styles.tally}>{t((d) => d.export.errors, { n: errors })}</span>
              ) : null}
            </div>
            <div className={styles.foot}>
              <QuietButton onClick={() => void cancelExport()}>
                {t((d) => d.export.cancel)}
              </QuietButton>
            </div>
          </div>
        ) : phase === "done" && summary ? (
          <div className={styles.done}>
            <span className={styles.dot} aria-hidden="true" />
            <ExportReport summary={summary} />
            <div className={styles.actions}>
              {destination ? (
                <QuietButton onClick={() => void openFolder(destination)}>
                  {t((d) => d.export.openFolder)}
                </QuietButton>
              ) : null}
              <PrimaryButton onClick={onClose}>{t((d) => d.common.close)}</PrimaryButton>
            </div>
          </div>
        ) : (
          <>
            <section className={styles.section}>
              <span className={styles.label}>{t((d) => d.export.destination)}</span>
              <ExportDestination destination={destination} onPick={() => void onPick()} />
              {check?.inside_workspace ? (
                <p className={styles.warn}>{t((d) => d.export.insideWorkspace)}</p>
              ) : null}
              {/* A picked destination the probe could not write to: read-only, gone, or otherwise blocked. */}
              {check && !check.inside_workspace && !check.writable ? (
                <p className={styles.warn}>{t((d) => d.export.notWritable)}</p>
              ) : null}
              {check?.ok && check.non_empty ? (
                <p className={styles.warn}>{t((d) => d.export.nonEmpty)}</p>
              ) : null}
            </section>

            <section className={styles.section}>
              <span className={styles.label}>{t((d) => d.export.layout)}</span>
              <ExportLayout
                folder={folder}
                file={file}
                selected={selectedPreset}
                onSelectPreset={onSelectPreset}
                onSelectCustom={() => setCustomMode(true)}
                onCustomPatterns={onCustomPatterns}
              />
            </section>

            <div className={styles.cta}>
              {confirming ? (
                <div className={styles.confirm}>
                  <span className={styles.warn}>{t((d) => d.export.nonEmpty)}</span>
                  <div className={styles.confirmActions}>
                    <PrimaryButton onClick={() => void runExport()}>
                      {t((d) => d.export.confirm)}
                    </PrimaryButton>
                    <QuietButton onClick={() => setConfirming(false)}>
                      {t((d) => d.export.cancel)}
                    </QuietButton>
                  </div>
                </div>
              ) : (
                <PrimaryButton onClick={onExport} disabled={!canExport}>
                  {t((d) => d.export.action)}
                </PrimaryButton>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
