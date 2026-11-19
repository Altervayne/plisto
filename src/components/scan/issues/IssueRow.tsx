// -- Framework Imports --
import { memo } from "react";

// -- Icon Imports --
import { ChevronDown, EyeOff, Folder, FolderOpen, RotateCw } from "lucide-react";

// -- Component Imports --
import { Tooltip } from "../../common/Tooltip";
import { TruncatedText } from "../../common/TruncatedText/TruncatedText";

// -- Utils Imports --
import { openFolder, revealFile } from "../../../lib/opener";
import { checkedJustNow, reasonHint, reasonLabel, shortenPath, splitPath } from "./issueText";

// -- Type Imports --
import type { ScanIssue } from "../../../types";

// -- i18n Imports --
import { useLocale, useT } from "../../../i18n";

// -- Style Imports --
import styles from "./IssueRow.module.css";

/**
 * One unreadable file or folder: its name over its shortened folder, the worded reason at the right, and
 * a column of quiet glyphs. Opening a row adds the reason's next step, the raw error text, the full path
 * and when it was seen, and a Retry beside the glyphs. The row and its detail are one surface. Paths and
 * error text render as plain text only.
 */
export const IssueRow = memo(function IssueRow({
  issue,
  open,
  busy,
  onToggle,
  onRetry,
  onDismiss,
}: {
  issue: ScanIssue;
  open: boolean;
  // A retry is running: Retry and Dismiss wait.
  busy: boolean;
  onToggle: (id: number) => void;
  onRetry: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const folder = issue.kind === "folder";
  const { name, dir } = splitPath(issue.path);
  const date = (seconds: number) =>
    new Date(seconds * 1000).toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const detailLabel = open ? t((d) => d.scan.issueHideDetails) : t((d) => d.scan.issueShowDetails);
  const revealLabel = folder ? t((d) => d.scan.issueOpenFolder) : t((d) => d.scan.issueReveal);
  const dismissLabel = t((d) => d.scan.issueDismissTip);
  const retryLabel = t((d) => d.scan.issueRetry);

  return (
    <div className={`${styles.item} ${open ? styles.open : ""}`}>
      <div className={styles.row}>
        <div className={styles.main}>
          <div className={styles.name}>
            {folder ? <Folder size={14} aria-hidden="true" /> : null}
            <TruncatedText text={name} className={styles.nameText} />
            {folder ? <span className={styles.tag}>{t((d) => d.scan.issueKindFolder)}</span> : null}
          </div>
          <Tooltip label={dir}>
            <div className={styles.path}>{shortenPath(dir)}</div>
          </Tooltip>
        </div>
        <span className={styles.reason}>{reasonLabel(t, issue.reason)}</span>
        <span className={styles.acts}>
          <Tooltip label={detailLabel}>
            <button
              type="button"
              className={`${styles.glyph} ${open ? styles.expanded : ""}`}
              aria-expanded={open}
              aria-label={detailLabel}
              onClick={() => onToggle(issue.id)}
            >
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </Tooltip>
          {open ? (
            <Tooltip label={retryLabel}>
              <button
                type="button"
                className={styles.glyph}
                aria-label={retryLabel}
                disabled={busy}
                onClick={() => onRetry(issue.id)}
              >
                <RotateCw size={15} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : (
            <span className={`${styles.glyph} ${styles.ghost}`} aria-hidden="true" />
          )}
          <Tooltip label={revealLabel}>
            <button
              type="button"
              className={styles.glyph}
              aria-label={revealLabel}
              onClick={() => void (folder ? openFolder(issue.path) : revealFile(issue.path))}
            >
              <FolderOpen size={15} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip label={dismissLabel}>
            <button
              type="button"
              className={styles.glyph}
              aria-label={dismissLabel}
              disabled={busy}
              onClick={() => onDismiss(issue.id)}
            >
              <EyeOff size={15} aria-hidden="true" />
            </button>
          </Tooltip>
        </span>
      </div>

      {open ? (
        <div className={styles.detail}>
          <p className={styles.hint}>{reasonHint(t, issue.reason)}</p>
          <dl className={styles.facts}>
            {issue.detail ? (
              <>
                <dt>{t((d) => d.scan.issueRawDetail)}</dt>
                <dd className={styles.mono}>{issue.detail}</dd>
              </>
            ) : null}
            <dt>{t((d) => d.scan.issueFullPath)}</dt>
            <dd className={styles.mono}>{issue.path}</dd>
            <dt>{t((d) => d.scan.issueFirstSeen)}</dt>
            <dd>{date(issue.first_seen)}</dd>
            <dt>{t((d) => d.scan.issueLastSeen)}</dt>
            <dd>
              {checkedJustNow(issue.last_seen, Date.now() / 1000)
                ? t((d) => d.scan.issueCheckedNow)
                : date(issue.last_seen)}
            </dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
});
