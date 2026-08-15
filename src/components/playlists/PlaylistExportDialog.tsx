// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { ExportReport } from "../export/ExportReport";

// -- IPC Imports --
import {
  cancelPlaylistExport,
  createExportChannel,
  exportPlaylistFolder,
  exportPlaylistM3u,
  exportPlaylistRichM3u8,
} from "../../lib/ipc";

// -- Utils Imports --
import { pickFolder, pickPlaylistSavePath } from "../../lib/dialog";
import { openFolder } from "../../lib/opener";

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { ExportProgress, ExportSummary, PlaylistM3uSummary, PlaylistRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistExportDialog.module.css";

/** The three export shapes: a plain file, an album-structured folder of copies, a rich re-openable folder. */
type ExportType = "m3u" | "folder" | "rich";

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
  { id: "rich", label: (d) => d.playlists.export.richLabel, desc: (d) => d.playlists.export.richDesc },
];

/**
 * The playlist export dialog, a dimmed modal over one playlist. Three selectable type cards each carry a
 * one-line description; an inline warn shows only when the chosen type would drop data the playlist
 * actually holds (a description, a cover). Export picks its destination on click - a save-file for the
 * plain .m3u, a folder for the two folder shapes - then runs: the plain and rich exports resolve at once
 * into a written/skipped summary, while the album folder streams progress with a cancel, mirroring the
 * library export, before its fuller report. It portals to the body and dismisses on Escape, a backdrop
 * press, or the close button - never mid-run, so a folder copy is not abandoned by a stray key.
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
  // The directory a run wrote into, kept for the done screen's Open action - set for the two folder
  // shapes, left null for the plain .m3u whose destination is a file, not a folder.
  const [openDest, setOpenDest] = useState<string | null>(null);

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
  // Each warn fires only when the playlist carries the data this type would leave behind.
  const warnDescription = hasDescription && (type === "m3u" || type === "folder");
  const warnCover = hasCover && type === "m3u";

  const untitled = playlist.name == null || playlist.name === "";
  const defaultFileName = `${untitled ? t((d) => d.playlists.untitled) : playlist.name}.m3u8`;

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

  const runFolder = useCallback(async () => {
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
      setFolderResult(await exportPlaylistFolder(playlist.id, dest, channel));
      setPhase("done");
    } catch {
      // A destination that went invalid mid-run drops back to the choice; the source is untouched.
      setPhase("idle");
    }
  }, [playlist.id]);

  const onExport = useCallback(() => {
    if (type === "m3u") {
      void runFile(
        (dest) => exportPlaylistM3u(playlist.id, dest),
        () => pickPlaylistSavePath(defaultFileName),
        false,
      );
    } else if (type === "rich") {
      void runFile((dest) => exportPlaylistRichM3u8(playlist.id, dest), pickFolder, true);
    } else {
      void runFolder();
    }
  }, [type, playlist.id, defaultFileName, runFile, runFolder]);

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
            {openDest ? (
              <Tooltip label={openDest}>
                <p className={styles.path}>{openDest}</p>
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
              <PrimaryButton onClick={onExport}>{t((d) => d.playlists.export.run)}</PrimaryButton>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
