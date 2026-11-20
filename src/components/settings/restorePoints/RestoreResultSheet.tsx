// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { ConfirmDialog } from "../../common/ConfirmDialog/ConfirmDialog";
import { LostFacts } from "./LostFacts";
import { UnmatchedList } from "./UnmatchedList";

// -- Utils Imports --
import { copyToClipboard } from "../../../lib/clipboard";
import { unmatchedText } from "./restorePointModel";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { RestoreSummary } from "../../../types";

// -- Style Imports --
import styles from "./RestorePoints.module.css";

const COPY_NOTE_MS = 2000;

/**
 * The sheet after a restore: what is back, what was not found, and the unmatched list with Copy list.
 * Undo restore sits beside Done when the library as it was had been saved; it restores that point.
 * Escape and Done both close it.
 */
export function RestoreResultSheet({
  when,
  summary,
  canUndo,
  undoBusy = false,
  onUndo,
  onDone,
}: {
  when: string;
  summary: RestoreSummary;
  canUndo: boolean;
  undoBusy?: boolean;
  onUndo: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const missing = summary.unmatched_tracks;

  // The outcome label falls back to the count after a moment.
  useEffect(() => {
    if (copy === "idle") return;
    const timer = window.setTimeout(() => setCopy("idle"), COPY_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const onCopy = () => {
    const text = unmatchedText(summary.unmatched, {
      albums: t((d) => d.restorePoints.groupAlbums),
      playlists: t((d) => d.restorePoints.groupPlaylists),
      other: t((d) => d.restorePoints.groupOther),
    });
    void copyToClipboard(text).then((ok) => setCopy(ok ? "copied" : "failed"));
  };

  const copyLabel =
    copy === "copied"
      ? t((d) => d.restorePoints.copied)
      : copy === "failed"
        ? t((d) => d.restorePoints.copyFailed)
        : t((d) => d.restorePoints.copyList, { n: missing });

  const sum = t((d) => d.restorePoints.resultSum, {
    albums: t((d) => d.restorePoints.albums, { n: summary.albums }),
    singles: t((d) => d.restorePoints.singles, { n: summary.singles }),
    playlists: t((d) => d.restorePoints.playlists, { n: summary.playlists }),
  });

  return (
    <ConfirmDialog
      open
      width="wide"
      hideCancel
      title={t((d) => d.restorePoints.resultTitle, { when })}
      prompt=""
      confirmLabel={t((d) => d.restorePoints.done)}
      cancelLabel={t((d) => d.common.cancel)}
      secondary={canUndo ? { label: t((d) => d.restorePoints.undo), onClick: onUndo } : undefined}
      onConfirm={() => {}}
      onClose={onDone}
    >
      <div className={styles.body}>
        <LostFacts summary={summary} lead={<li>{sum}</li>} />
        {canUndo || missing > 0 ? (
          <div className={styles.tool}>
            <span className={undoBusy ? `${styles.safe} ${styles.lineWarn}` : styles.safe}>
              {undoBusy ? t((d) => d.restorePoints.undoBusy) : canUndo ? t((d) => d.restorePoints.undoLine) : ""}
            </span>
            {missing > 0 ? (
              <button type="button" className={styles.toolButton} onClick={onCopy}>
                {copyLabel}
              </button>
            ) : null}
          </div>
        ) : null}
        {summary.unmatched.length > 0 ? <UnmatchedList groups={summary.unmatched} showPaths /> : null}
      </div>
    </ConfirmDialog>
  );
}
