// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

// -- Icon Imports --
import { Info, Trash2 } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { KeptBackupDialogs } from "./KeptBackupDialogs";
import { KeptBackupRow } from "./KeptBackupRow";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";
import { useKeptBackups } from "./useKeptBackups";

// -- State Imports --
import { useTrimBackupDays } from "../../state/preferences/store";
import { openSettings } from "../../state/shell/store";

// -- Utils Imports --
import { discardable, summaryLine } from "../../lib/keptBackups";
import type { KeptAsk } from "../../lib/keptBackups";
import { escapeTarget, wrapTab } from "../gone/goneFocus";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./KeptBackupsSheet.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/**
 * The hidden originals kept beside trimmed files, as a dimmed modal. Each row offers Undo trim and
 * Discard behind their own confirm; Discard all clears every backup it can reach. The list is re-read
 * after every action, so a row is never shown in a state the backend has moved on from.
 */
export function KeptBackupsSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const kept = useKeptBackups();
  const keepDays = useTrimBackupDays();
  const [ask, setAsk] = useState<KeptAsk | null>(null);
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);

  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  // Escape answers the confirm first; the sheet stays until the confirm is gone.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escapeTarget(ask != null) === "sheet") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, ask]);

  // Focus moves into the panel on open and returns to whatever opened it when it goes.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector("button")?.focus();
    return () => opener?.focus();
  }, []);

  // Tab wraps inside the panel. The confirms portal out of it, so only keys from inside count.
  const onPanelKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (event.key !== "Tab" || !panel || !panel.contains(event.target as Node)) return;
    const items = [...panel.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    const next = wrapTab(items.indexOf(event.target as HTMLElement), items.length, event.shiftKey);
    if (next == null) return;
    event.preventDefault();
    items[next].focus();
  };

  const { backups } = kept;
  // Ages and expiry read one clock per list, so rows do not drift while the sheet stays open.
  const nowMs = useMemo(() => Date.now(), [backups]);
  const reachable = useMemo(() => discardable(backups ?? []), [backups]);

  if (!card.mounted) return null;

  const title = t((d) => d.fileWrites.kept.title);
  const empty = backups != null && backups.length === 0;
  const loadLine = kept.loadFailed ? t((d) => d.fileWrites.kept.loadFailed) : null;
  const change = () => {
    requestClose();
    openSettings({ target: "trimReplace" });
  };

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onPanelKey}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.sub}>{t((d) => d.fileWrites.kept.sub)}</p>
          </div>
          <QuietButton onClick={requestClose}>{t((d) => d.fileWrites.close)}</QuietButton>
        </div>

        {backups != null && !empty ? (
          <p className={styles.summary}>
            {summaryLine(t, backups, keepDays === "never" ? null : Number(keepDays))}
            <button type="button" className={styles.change} onClick={change}>
              {t((d) => d.fileWrites.kept.change)}
            </button>
          </p>
        ) : null}

        {[loadLine, kept.error].map((line) =>
          line ? (
            <p key={line} className={styles.error} role="alert">
              {line}
            </p>
          ) : null,
        )}

        {kept.notice ? (
          <p className={styles.notice} role="status">
            <Info className={styles.noticeIcon} size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{kept.notice}</span>
          </p>
        ) : null}

        <ScrollArea className={styles.list} contentClassName={styles.body}>
          {empty ? (
            <div className={styles.empty}>
              <span className={styles.tone} aria-hidden="true" />
              <p className={styles.emptyTitle}>{t((d) => d.fileWrites.kept.emptyTitle)}</p>
              <p className={styles.emptyLine}>{t((d) => d.fileWrites.kept.emptyLine)}</p>
            </div>
          ) : (
            (backups ?? []).map((backup) => (
              <KeptBackupRow
                key={backup.undoId}
                backup={backup}
                nowMs={nowMs}
                disabled={kept.working}
                onUndo={() => setAsk({ kind: "undo", backup })}
                onDiscard={() => setAsk({ kind: "discard", backup })}
                onRemove={() => void kept.discard(backup)}
              />
            ))
          )}
        </ScrollArea>

        <div className={styles.foot}>
          <span className={styles.safety}>
            <Info className={styles.safetyIcon} size={13} strokeWidth={1.8} aria-hidden="true" />
            {t((d) => d.fileWrites.kept.foot)}
          </span>
          {reachable.length > 0 ? (
            <QuietButton destructive onClick={() => setAsk({ kind: "all" })} disabled={kept.working}>
              <Trash2 size={14} strokeWidth={1.8} aria-hidden="true" /> {t((d) => d.fileWrites.kept.discardAll)}
            </QuietButton>
          ) : null}
          <PrimaryButton onClick={requestClose}>{t((d) => d.fileWrites.done)}</PrimaryButton>
        </div>

        <KeptBackupDialogs
          ask={ask}
          all={reachable}
          onUndo={(backup) => void kept.undo(backup)}
          onDiscard={(backup) => void kept.discard(backup)}
          onDiscardAll={() => void kept.discardAll()}
          onClose={() => setAsk(null)}
        />
      </div>
    </div>,
    document.body,
  );
}
