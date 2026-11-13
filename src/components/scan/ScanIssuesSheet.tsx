// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Icon Imports --
import { RotateCw } from "lucide-react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { CopyListPanel } from "./issues/CopyListPanel";
import { IssueBanner } from "./issues/IssueBanner";
import { IssueBar } from "./issues/IssueBar";
import { IssueChips } from "./issues/IssueChips";
import { IssueRow } from "./issues/IssueRow";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import { ISSUES_PAGE_SIZE, useScanIssuesStore } from "../../state/scanIssues";

// -- Utils Imports --
import { standingTotal } from "./issues/issueText";

// -- i18n Imports --
import { useLocale, useT } from "../../i18n";

// -- Style Imports --
import styles from "./ScanIssuesSheet.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/**
 * The unreadable-files review, a dimmed modal over Settings. Files and folders a scan could not read
 * list in folder-then-name order, a page at a time; a reason chip narrows the list and the bar actions
 * (Retry, Copy list, Dismiss) with it. Dismiss hides a row until its file changes. Nothing here touches
 * the files. Escape closes an open confirm or the Copy panel first, then the sheet.
 */
export function ScanIssuesSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const rows = useScanIssuesStore((s) => s.rows);
  const total = useScanIssuesStore((s) => s.total);
  const byReason = useScanIssuesStore((s) => s.byReason);
  const filter = useScanIssuesStore((s) => s.filter);
  const status = useScanIssuesStore((s) => s.listStatus);
  const notice = useScanIssuesStore((s) => s.notice);
  const store = useScanIssuesStore.getState();

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [copying, setCopying] = useState(false);

  // Own the card's lifetime so a close plays its exit before the host drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  useEffect(() => {
    void useScanIssuesStore.getState().loadFirst();
    void useScanIssuesStore.getState().refreshCount();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirming && !copying) requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, confirming, copying]);

  const toggle = useCallback((id: number) => {
    useScanIssuesStore.getState().clearNotice();
    setExpanded((held) => {
      const next = new Set(held);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const retryOne = useCallback((id: number) => void useScanIssuesStore.getState().retryOne(id), []);
  const dismissOne = useCallback(
    (id: number) => void useScanIssuesStore.getState().dismissOne(id),
    [],
  );
  const closeCopy = useCallback(() => setCopying(false), []);
  const closeConfirm = useCallback(() => setConfirming(false), []);

  if (!card.mounted) return null;

  const title = t((d) => d.scan.issuesTitle);
  const retrying = notice?.kind === "retrying";
  const standing = standingTotal(byReason);
  const failedCold = rows.length === 0 && status === "error";
  // Rows held through a failed read no longer match the header and chips: they dim, and the error says so.
  const stale = rows.length > 0 && status === "error";
  const loadingCold = rows.length === 0 && (status === "idle" || status === "loading");
  const empty = rows.length === 0 && status === "ready";
  const showing =
    rows.length > 0 && rows.length < standing
      ? t((d) => d.scan.issueShowing, { shown: rows.length, total: standing })
      : null;

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>
              {title}
              {!failedCold && standing > 0 ? (
                <span className={`${styles.count} tabular`}>{standing.toLocaleString(locale)}</span>
              ) : null}
            </h2>
            {showing ? <p className={styles.summary}>{showing}</p> : null}
            <p className={styles.safety}>{t((d) => d.scan.issuesSub)}</p>
            <p className={styles.safety}>{t((d) => d.scan.issueDismissNote)}</p>
          </div>
          <QuietButton onClick={requestClose}>{t((d) => d.common.close)}</QuietButton>
        </div>

        <IssueChips byReason={byReason} filter={filter} onPick={(reason) => void store.setFilter(reason)} />
        {stale ? (
          <div className={styles.inlineError} role="alert">
            <span>{t((d) => d.scan.issueLoadError)}</span>
            <QuietButton onClick={() => void store.loadFirst()}>
              <RotateCw size={15} aria-hidden="true" />
              {t((d) => d.scan.issueRetry)}
            </QuietButton>
          </div>
        ) : (
          <IssueBanner notice={notice} />
        )}

        {loadingCold ? (
          <div className={styles.skeleton} aria-busy="true">
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className={styles.skeletonRow}>
                <div>
                  <i />
                  <i />
                </div>
                <em />
              </div>
            ))}
            <p className={styles.loading}>{t((d) => d.scan.issueLoading)}</p>
          </div>
        ) : failedCold ? (
          <div className={styles.center}>
            <b>{t((d) => d.scan.issueLoadError)}</b>
            <span>{t((d) => d.scan.issueLoadErrorBody)}</span>
            <QuietButton onClick={() => void store.loadFirst()}>
              <RotateCw size={15} aria-hidden="true" />
              {t((d) => d.scan.issueRetry)}
            </QuietButton>
          </div>
        ) : empty ? (
          <div className={styles.center}>
            <b>{t((d) => d.scan.issueEmptyTitle)}</b>
            <span>{t((d) => d.scan.issueEmptyBody)}</span>
          </div>
        ) : (
          <>
            <ScrollArea
              className={`${styles.list} ${stale ? styles.stale : ""}`}
              contentClassName={styles.rows}
            >
              {rows.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  open={expanded.has(issue.id)}
                  busy={retrying}
                  onToggle={toggle}
                  onRetry={retryOne}
                  onDismiss={dismissOne}
                />
              ))}
              {rows.length < total ? (
                <div className={styles.more}>
                  <QuietButton onClick={() => void store.loadMore()} disabled={status === "loading"}>
                    {t((d) => d.scan.issueShowMore, { n: Math.min(ISSUES_PAGE_SIZE, total - rows.length) })}
                  </QuietButton>
                </div>
              ) : null}
            </ScrollArea>
            <IssueBar
              n={total}
              filtered={filter !== null}
              retrying={retrying}
              onRetry={() => void store.retryShown()}
              onCopy={() => setCopying(true)}
              onOpenLog={() => void store.openLog()}
              onDismiss={() => setConfirming(true)}
            />
            <p className={styles.logLine}>{t((d) => d.scan.issueLogNote)}</p>
          </>
        )}
      </div>

      {copying ? <CopyListPanel onClose={closeCopy} /> : null}
      <ConfirmDialog
        open={confirming}
        title={t((d) => d.scan.issueConfirmTitle, { n: total })}
        prompt={t((d) => d.scan.issueConfirmBody)}
        confirmLabel={t((d) => d.scan.issueDismiss)}
        cancelLabel={t((d) => d.common.cancel)}
        onConfirm={() => void store.dismissShown()}
        onClose={closeConfirm}
      />
    </div>,
    document.body,
  );
}
