// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Channel } from "@tauri-apps/api/core";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { ExportDestination } from "../export/ExportDestination";
import { ExportReport } from "../export/ExportReport";
import { ExportLayout } from "../export/ExportLayout";

// -- IPC Imports --
import {
  cancelPlaylistExport,
  checkDevice,
  createExportChannel,
  exportPlaylistFolder,
  exportPlaylistM3u,
  exportPlaylistMimicAlbum,
  exportPlaylistRichM3u8,
  pickDeviceFolder,
  validateExportDestination,
} from "../../lib/ipc";

// -- Utils Imports --
import { pickFolder, pickPlaylistSavePath } from "../../lib/dialog";
import { openFolder } from "../../lib/opener";

// -- Local Imports --
import { DEFAULT_PRESET, presetIdFor } from "../export/templates";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { ExportPreset } from "../export/templates";
import type {
  DestinationCheck,
  ExportProgress,
  ExportSummary,
  ExportTarget,
  PlaylistM3uSummary,
  PlaylistRow,
} from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistExportDialog.module.css";

/**
 * The four export shapes: a plain file, an album-structured folder of copies, a rich re-openable
 * folder, and a flat mimic album of copies named after the playlist.
 */
type ExportType = "m3u" | "folder" | "rich" | "mimic";

/** Which screen the dialog shows: the type choice, the live folder run, then the result. */
type Phase = "idle" | "running" | "done";

/** Each type choice with its label and the one line describing what it produces and preserves. */
const TYPES: { id: ExportType; label: (d: Dict) => string; desc: (d: Dict) => string }[] = [
  { id: "m3u", label: (d) => d.playlists.export.m3uLabel, desc: (d) => d.playlists.export.m3uDesc },
  {
    id: "folder",
    label: (d) => d.playlists.export.folderLabel,
    desc: (d) => d.playlists.export.folderDesc,
  },
  {
    id: "mimic",
    label: (d) => d.playlists.export.mimicLabel,
    desc: (d) => d.playlists.export.mimicDesc,
  },
  { id: "rich", label: (d) => d.playlists.export.richLabel, desc: (d) => d.playlists.export.richDesc },
];

/**
 * The playlist export dialog, a dimmed modal over one playlist. Four selectable type cards each carry a
 * one-line description; an inline warn shows only when the chosen type would drop data the playlist
 * actually holds (a description, a cover). The album folder shape pre-picks a typed destination up front -
 * a real folder or a connected device, mirroring the library export - and runs it on the Export click; the
 * plain .m3u, rich .m3u8 and mimic shapes still pick their destination on the click itself. The plain and
 * rich exports resolve at once into a written/skipped summary, while both folder shapes stream progress
 * with a cancel before a fuller report, a device naming its two staging/transfer phases. It portals to the
 * body and dismisses on Escape, a backdrop press, or the close button - never mid-run, so a copy is not
 * abandoned by a stray key.
 */
export function PlaylistExportDialog({
  playlist,
  onClose,
}: {
  playlist: PlaylistRow;
  onClose: () => void;
}) {
  const t = useT();

  const [type, setType] = useState<ExportType>("m3u");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [fileResult, setFileResult] = useState<PlaylistM3uSummary | null>(null);
  const [folderResult, setFolderResult] = useState<ExportSummary | null>(null);
  // The album layout for the folder shape, a per-export choice seeded from the Artist/Album default.
  // Custom mode is a UI intent, holding the fields open even while the patterns still spell a preset.
  const [folderPattern, setFolderPattern] = useState(DEFAULT_PRESET.folder);
  const [filePattern, setFilePattern] = useState(DEFAULT_PRESET.file);
  const [customMode, setCustomMode] = useState(false);
  // The directory a run wrote into, kept for the done screen's Open action - set for the two folder
  // shapes, left null for the plain .m3u whose destination is a file, not a folder.
  const [openDest, setOpenDest] = useState<string | null>(null);
  // The pre-picked typed destination for the album folder shape - a real folder or a connected device.
  // The other three shapes pick their destination on the Export click and never touch these.
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  // A failed folder-shape run's reason, shown back on the idle screen. Cleared on a fresh pick or run.
  const [error, setError] = useState<string | null>(null);
  // Device mode for the folder shape: dated snapshot (false) vs in-place merge into the picked folder
  // (true). A device target alone reads it.
  const [deviceInPlace, setDeviceInPlace] = useState(false);

  const running = phase === "running";

  // Escape dismisses, matching the backdrop and close button, but stays off during a run.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const hasDescription = playlist.description != null;
  const hasCover = playlist.cover_id != null;
  // Each warn fires only when the playlist carries the data this type would leave behind. Only the
  // rich .m3u8 keeps the description; the mimic album folds tracks into a compilation with no room
  // for it, so it warns alongside the plain and album-structured shapes. Every folder shape keeps the
  // cover, so only the plain .m3u warns there.
  const warnDescription =
    hasDescription && (type === "m3u" || type === "folder" || type === "mimic");
  const warnCover = hasCover && type === "m3u";

  const untitled = playlist.name == null || playlist.name === "";
  const defaultFileName = `${untitled ? t((d) => d.playlists.untitled) : playlist.name}.m3u8`;

  const derivedPreset = presetIdFor(folderPattern, filePattern);
  const selectedPreset = customMode || derivedPreset === null ? "custom" : derivedPreset;

  const onSelectPreset = useCallback((preset: ExportPreset) => {
    setCustomMode(false);
    setFolderPattern(preset.folder);
    setFilePattern(preset.file);
  }, []);

  const onCustomPatterns = useCallback((nextFolder: string, nextFile: string) => {
    setFolderPattern(nextFolder);
    setFilePattern(nextFile);
  }, []);

  // The plain and rich exports share a shape: pick a destination, run, hold the count summary. `openable`
  // marks the folder destinations, whose done screen offers an Open. A null pick is the OS dialog
  // cancelled - a no-op.
  const runFile = useCallback(
    async (
      run: (dest: string) => Promise<PlaylistM3uSummary>,
      pick: () => Promise<string | null>,
      openable: boolean,
    ) => {
      const dest = await pick();
      if (!dest) return;
      try {
        setFileResult(await run(dest));
        setOpenDest(openable ? dest : null);
        setPhase("done");
      } catch {
        // The write failed or the desktop runtime is absent; stay on the choice, nothing was committed.
      }
    },
    [],
  );

  // The folder and mimic shapes share the streaming run: pick a folder, stream progress, hold the
  // report. They differ only in the backend call, passed in as `run` - the album-structured folder
  // carries the layout patterns, the flat mimic takes none.
  const runFolder = useCallback(
    async (run: (dest: string, channel: Channel<ExportProgress>) => Promise<ExportSummary>) => {
      const dest = await pickFolder();
      if (!dest) return;
      setOpenDest(dest);
      setProgress(null);
      setFolderResult(null);
      setPhase("running");

      const channel = createExportChannel((tick) => {
        // exported is monotonic on the backend; guard an out-of-order tick from regressing it.
        setProgress((prev) => {
          const exported = prev ? Math.max(prev.exported, tick.exported) : tick.exported;
          return { ...tick, exported };
        });
      });

      try {
        setFolderResult(await run(dest, channel));
        setPhase("done");
      } catch {
        // A destination that went invalid mid-run drops back to the choice; the source is untouched.
        setPhase("idle");
      }
    },
    [],
  );

  // The album folder shape pre-picks its destination, so the pick lands a validated target the Export
  // click then runs. A folder pick probes for workspace overlap and writability; a device pick re-resolves
  // its PIDL to confirm the phone is still on the bus. A null pick is the OS dialog cancelled - a no-op.
  const onPickFolder = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setTarget({ kind: "folder", path: picked });
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
    setError(null);
    try {
      setCheck(await checkDevice(picked.pidl));
    } catch {
      setCheck(null);
    }
  }, []);

  // The album folder shape's run, over the pre-picked target: a folder writes straight into its path, a
  // device stages the copies to a temp folder and transfers them onto the phone. Streams progress, holds
  // the report. The other three shapes keep their pick-on-click runs (runFile/runFolder).
  const runToTarget = useCallback(async () => {
    if (!target) return;
    setError(null);
    setProgress(null);
    setFolderResult(null);
    setPhase("running");

    const channel = createExportChannel((tick) => {
      // exported is monotonic within a phase, but a device export runs two phases at different scales -
      // the staging pass counts bytes staged, the transfer counts bytes moved. Carrying the staging max
      // into the transfer would pin the bar full, so the guard resets on a phase change, clamping within one.
      setProgress((prev) => {
        const exported =
          prev && prev.phase === tick.phase ? Math.max(prev.exported, tick.exported) : tick.exported;
        return { ...tick, exported };
      });
    });

    try {
      const summary = await exportPlaylistFolder(
        playlist.id,
        target,
        channel,
        folderPattern,
        filePattern,
        deviceInPlace,
      );
      setFolderResult(summary);
      // A folder path is the only openable destination; a device has none, so the done screen drops Open.
      setOpenDest(target.kind === "folder" ? target.path : null);
      setPhase("done");
    } catch {
      // A device that dropped off mid-copy, or a folder gone invalid, drops back to the pick with the
      // reason surfaced. The source is untouched; a device may hold a partial copy (no rollback), which
      // the message is honest about.
      setPhase("idle");
      setError(
        target.kind === "device"
          ? t((d) => d.export.deviceTransferFailed)
          : t((d) => d.export.exportFailed),
      );
    }
  }, [target, playlist.id, folderPattern, filePattern, deviceInPlace, t]);

  const onExport = useCallback(() => {
    if (type === "m3u") {
      void runFile(
        (dest) => exportPlaylistM3u(playlist.id, dest),
        () => pickPlaylistSavePath(defaultFileName),
        false,
      );
    } else if (type === "rich") {
      void runFile((dest) => exportPlaylistRichM3u8(playlist.id, dest), pickFolder, true);
    } else if (type === "mimic") {
      void runFolder((dest, channel) => exportPlaylistMimicAlbum(playlist.id, dest, channel));
    } else {
      void runToTarget();
    }
  }, [type, playlist.id, defaultFileName, runFile, runFolder, runToTarget]);

  // A validated target - a folder or a connected device - readies the album folder shape. `ok` stays
  // true for a non-empty destination (it only warns), so a merge into an existing folder is allowed.
  const canExportFolder = !!target && !!check?.ok;

  const total = progress?.total ?? 0;
  const exported = progress?.exported ?? 0;
  const errors = progress?.errors ?? 0;
  const phaseNow = progress?.phase;
  // The line under the progress bar: a folder shows its path, a device its human-readable display name.
  // The mimic/rich shapes carry no typed target, so they fall back to the folder they picked on click.
  const destLine = target
    ? target.kind === "folder"
      ? target.path
      : target.target.display
    : openDest;
  // A device export runs two named phases; every folder run only ever copies. The title follows the phase
  // so a device reads Writing while it stages, then Transferring while it moves onto the phone. A folder
  // run leans on the header alone.
  const runTitle =
    target?.kind === "device" && phaseNow === "copying"
      ? t((d) => d.export.writing)
      : target?.kind === "device" && phaseNow === "transferring"
        ? t((d) => d.export.transferring)
        : null;
  // The staging phase counts bytes with no meaningful total to divide against, so the device bar runs
  // indeterminate while it writes the temp folder, then goes determinate once the transfer begins. Every
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
        aria-label={t((d) => d.playlists.export.title)}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{t((d) => d.playlists.export.title)}</h2>
          {!running ? (
            <QuietButton onClick={onClose} aria-label={t((d) => d.common.close)}>
              {t((d) => d.common.close)}
            </QuietButton>
          ) : null}
        </div>

        {phase === "running" ? (
          <div className={styles.run}>
            {/* A device names its two phases; every folder run leans on the persistent header alone. */}
            {runTitle ? <span className={styles.phase}>{runTitle}</span> : null}
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
              <QuietButton onClick={() => void cancelPlaylistExport()}>
                {t((d) => d.export.cancel)}
              </QuietButton>
            </div>
          </div>
        ) : phase === "done" ? (
          <div className={styles.done}>
            <span className={styles.dot} aria-hidden="true" />
            {folderResult ? (
              <ExportReport summary={folderResult} />
            ) : fileResult ? (
              <div className={styles.report}>
                <span className={styles.written}>
                  {t((d) => d.export.written, { n: fileResult.written })}
                </span>
                {fileResult.skipped_missing > 0 ? (
                  <span className={styles.skipped}>
                    {t((d) => d.export.missing, { n: fileResult.skipped_missing })}
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* A device leaves no folder to open, so name where the copies went in its place. A cancelled
                run only partly landed, so it says so rather than claiming the whole playlist reached the
                phone. Only the album folder shape can run to a device. */}
            {target?.kind === "device" ? (
              <p className={styles.hint}>
                {folderResult?.cancelled
                  ? t((d) => d.export.partlySentTo, { device: target.target.device_name })
                  : t((d) => d.export.sentTo, { device: target.target.device_name })}
              </p>
            ) : null}
            <div className={styles.actions}>
              {openDest ? (
                <QuietButton onClick={() => void openFolder(openDest)}>
                  {t((d) => d.export.openFolder)}
                </QuietButton>
              ) : null}
              <PrimaryButton onClick={onClose}>{t((d) => d.common.close)}</PrimaryButton>
            </div>
          </div>
        ) : (
          <>
            <div
              className={styles.types}
              role="radiogroup"
              aria-label={t((d) => d.playlists.export.title)}
            >
              {TYPES.map((choice) => {
                const selected = choice.id === type;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={styles.card}
                    data-selected={selected ? "" : undefined}
                    onClick={() => setType(choice.id)}
                  >
                    <span className={styles.cardLabel}>{t(choice.label)}</span>
                    <span className={styles.cardDesc}>{t(choice.desc)}</span>
                  </button>
                );
              })}
            </div>

            {/* The album-structured folder is the only shape with a layout to shape; the flat mimic
                numbers its copies with the default file pattern, and the two file shapes have none. */}
            {type === "folder" ? (
              <ExportLayout
                folder={folderPattern}
                file={filePattern}
                selected={selectedPreset}
                onSelectPreset={onSelectPreset}
                onSelectCustom={() => setCustomMode(true)}
                onCustomPatterns={onCustomPatterns}
              />
            ) : null}

            {/* The album folder shape alone pre-picks a typed destination - a real folder or a connected
                device - mirroring the library export's pick. The other three shapes pick on the Export
                click, so no destination section shows for them. */}
            {type === "folder" ? (
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
                {/* The failed-probe line: a folder that could not be written to, or a device that dropped
                    off the bus between the pick and the check. */}
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
                {/* A device offers a dated snapshot or an in-place merge into the picked folder. Shown only
                    once a device is the target. */}
                {target?.kind === "device" ? (
                  <div className={styles.deviceMode}>
                    <SegmentedControl
                      segments={[
                        { value: "snapshot", label: t((d) => d.export.deviceSnapshot) },
                        { value: "inplace", label: t((d) => d.export.deviceUpdate) },
                      ]}
                      value={deviceInPlace ? "inplace" : "snapshot"}
                      onChange={(v) => setDeviceInPlace(v === "inplace")}
                      label={t((d) => d.export.deviceModeLabel)}
                    />
                    <p className={styles.hint}>
                      {deviceInPlace
                        ? t((d) => d.export.deviceUpdateHint)
                        : t((d) => d.export.deviceSnapshotHint)}
                    </p>
                  </div>
                ) : null}
                {/* A run that failed (a device that dropped off mid-copy, a folder gone invalid) surfaces
                    its reason here rather than silently returning to the pick. */}
                {error ? <p className={styles.warn}>{error}</p> : null}
              </section>
            ) : null}

            {warnDescription || warnCover ? (
              <div className={styles.warnings}>
                {warnDescription ? (
                  <p className={styles.warn}>{t((d) => d.playlists.export.warnDescription)}</p>
                ) : null}
                {warnCover ? (
                  <p className={styles.warn}>{t((d) => d.playlists.export.warnCover)}</p>
                ) : null}
              </div>
            ) : null}

            <div className={styles.footer}>
              {/* The album folder shape gates on a validated destination; the other three pick theirs on
                  the click, so their button always stands ready. */}
              <PrimaryButton
                onClick={onExport}
                disabled={type === "folder" ? !canExportFolder : false}
              >
                {t((d) => d.playlists.export.run)}
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
