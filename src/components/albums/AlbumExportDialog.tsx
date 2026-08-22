// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { ExportDestination } from "../export/ExportDestination";
import { ExportLayout } from "../export/ExportLayout";
import { ExportReport } from "../export/ExportReport";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";

// -- IPC Imports --
import {
  cancelExport,
  checkDevice,
  createExportChannel,
  exportLibrary,
  pickDeviceFolder,
  validateExportDestination,
} from "../../lib/ipc";

// -- Utils Imports --
import { pickFolder } from "../../lib/dialog";
import { openFolder } from "../../lib/opener";

// -- Local Imports --
import { DEFAULT_PRESET, presetIdFor } from "../export/templates";

// -- Type Imports --
import type { DestinationCheck, ExportProgress, ExportSummary, ExportTarget } from "../../types";
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
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [confirming, setConfirming] = useState(false);
  // A failed run's reason, shown on the idle screen. Cleared on a fresh pick or a new run.
  const [error, setError] = useState<string | null>(null);

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

  const onPickFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setTarget({ kind: "folder", path: picked });
    setConfirming(false);
    setError(null);
    try {
      setCheck(await validateExportDestination(picked));
    } catch {
      setCheck(null);
    }
  }, []);

  const onPickDevice = useCallback(async () => {
    const picked = await pickDeviceFolder();
    if (!picked) return;
    setTarget({ kind: "device", target: picked });
    setConfirming(false);
    setError(null);
    try {
      setCheck(await checkDevice(picked.pidl));
    } catch {
      setCheck(null);
    }
  }, []);

  const runExport = useCallback(async () => {
    if (!target) return;
    setConfirming(false);
    setError(null);
    setProgress(null);
    setSummary(null);
    setPhase("running");

    const channel = createExportChannel((tick) => {
      // exported is monotonic within a phase, but a device export runs two phases at different scales -
      // staging counts bytes staged, transferring counts bytes moved. Carrying the staging max into the
      // transfer would pin the bar full, so the guard resets on a phase change and only clamps within one.
      setProgress((prev) => {
        const exported =
          prev && prev.phase === tick.phase ? Math.max(prev.exported, tick.exported) : tick.exported;
        return { ...tick, exported };
      });
    });

    try {
      setSummary(await exportLibrary(target, channel, folder, file, { albumIds }));
      setPhase("done");
    } catch {
      // A failed run drops back to the pick with the reason surfaced. The source is untouched; a device
      // that dropped off mid-copy may hold a partial copy (no rollback), which the message is honest about.
      setPhase("idle");
      setError(
        target.kind === "device"
          ? t((d) => d.export.deviceTransferFailed)
          : t((d) => d.export.exportFailed),
      );
    }
  }, [target, t, folder, file, albumIds]);

  // A non-empty destination arms a two-step confirm; otherwise the click runs straight away.
  const onExport = useCallback(() => {
    if (check?.non_empty) {
      setConfirming(true);
      return;
    }
    void runExport();
  }, [check, runExport]);

  // A validated target with a non-empty selection is ready - a folder or a connected device alike.
  const canExport = !!target && !!check?.ok && albumIds.length > 0;

  // A folder path is the only openable destination, so it alone gates the done-screen Open button. A
  // device has no filesystem path, so this stays null for one and the button drops.
  const path = target?.kind === "folder" ? target.path : null;

  const total = progress?.total ?? 0;
  const exported = progress?.exported ?? 0;
  const errors = progress?.errors ?? 0;
  const phaseNow = progress?.phase;
  // The line under the spinner: a folder shows its path, a device its human-readable display name.
  const destLine =
    target?.kind === "folder"
      ? target.path
      : target?.kind === "device"
        ? target.target.display
        : null;
  // A device export runs two named phases; the folder export only ever copies. The title follows the
  // phase so the device reads Writing while it stages, then Transferring while it moves onto the device.
  const runTitle =
    target?.kind === "device" && phaseNow === "copying"
      ? t((d) => d.export.writing)
      : target?.kind === "device" && phaseNow === "transferring"
        ? t((d) => d.export.transferring)
        : null;
  // The staging phase counts bytes with no meaningful total to divide against, so the device bar runs
  // indeterminate while it writes the temp folder, then goes determinate once the transfer begins. A
  // folder copy stays determinate throughout.
  const value =
    target?.kind === "device" && phaseNow === "copying" ? null : total > 0 ? exported / total : null;

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
            <StaffSpinner />
            {/* A device names its two phases; the folder run leans on the persistent header alone. */}
            {runTitle ? <span className={styles.count}>{runTitle}</span> : null}
            {destLine ? (
              <Tooltip label={destLine}>
                <p className={styles.path}>{destLine}</p>
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
            {/* A device leaves no folder to open, so name where it went in its place. A cancelled run only
                partly landed, so it says so rather than claiming the whole selection reached the phone. */}
            {target?.kind === "device" ? (
              <p className={styles.hint}>
                {summary.cancelled
                  ? t((d) => d.export.partlySentTo, { device: target.target.device_name })
                  : t((d) => d.export.sentTo, { device: target.target.device_name })}
              </p>
            ) : null}
            <div className={styles.actions}>
              {path ? (
                <QuietButton onClick={() => void openFolder(path)}>
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
              <ExportDestination
                target={target}
                onPickFolder={() => void onPickFolder()}
                onPickDevice={() => void onPickDevice()}
              />
              {check?.inside_workspace ? (
                <p className={styles.warn}>{t((d) => d.export.insideWorkspace)}</p>
              ) : null}
              {/* The failed-probe line: a folder that could not be written to, or a device that dropped off
                  the bus between the pick and the check. */}
              {check && !check.inside_workspace && !check.writable ? (
                <p className={styles.warn}>
                  {target?.kind === "device"
                    ? t((d) => d.export.deviceDisconnected)
                    : t((d) => d.export.notWritable)}
                </p>
              ) : null}
              {check?.ok && check.non_empty ? (
                <p className={styles.warn}>{t((d) => d.export.nonEmpty)}</p>
              ) : null}
              {/* A run that failed (a device that dropped off mid-copy, a folder gone invalid) surfaces
                  its reason here rather than silently returning to the pick. */}
              {error ? <p className={styles.warn}>{error}</p> : null}
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
