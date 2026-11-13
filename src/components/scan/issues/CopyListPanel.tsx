// -- Framework Imports --
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

// -- Icon Imports --
import { Check, Copy } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../../common/PrimaryButton";
import { QuietButton } from "../../common/QuietButton";

// -- State Imports --
import { useScanIssuesStore } from "../../../state/scanIssues";

// -- Utils Imports --
import { copyToClipboard } from "../../../lib/clipboard";
import { copyPreview } from "./issueText";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./CopyListPanel.module.css";

/**
 * The Copy list panel: a preview of the text the clipboard receives, its first lines and how many more
 * follow, then Copy. The text comes from the backend in English whatever the language, already narrowed
 * by the sheet's filter. Escape or a backdrop press closes only this panel.
 */
export function CopyListPanel({ onClose }: { onClose: () => void }) {
  const readCopyText = useScanIssuesStore((s) => s.readCopyText);
  const [text, setText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // A failed read leaves its notice on the sheet and drops the panel.
  useEffect(() => {
    let live = true;
    void readCopyText().then((read) => {
      if (!live) return;
      if (read === null) onClose();
      else setText(read);
    });
    return () => {
      live = false;
    };
  }, [readCopyText, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onCopy = () => {
    if (text === null) return;
    void copyToClipboard(text).then(setCopied);
  };

  return createPortal(
    <CopyListView text={text} copied={copied} onCopy={onCopy} onClose={onClose} />,
    document.body,
  );
}

/** The panel's markup: the preview of `text` (a loading line while it is null) and its actions. */
export function CopyListView({
  text,
  copied,
  onCopy,
  onClose,
}: {
  text: string | null;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const preview = useMemo(() => (text === null ? null : copyPreview(text)), [text]);
  const title = t((d) => d.scan.issueCopyList);

  return (
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.lead}>{t((d) => d.scan.issueCopyLead)}</p>
        <pre className={styles.clip}>
          {preview ? (
            <>
              <span className={styles.header}>{preview.header}</span>
              {preview.lines.map((line) => `\n${line}`).join("")}
              {preview.more > 0 ? (
                <span className={styles.more}>{t((d) => d.scan.issueCopyMore, { n: preview.more })}</span>
              ) : null}
            </>
          ) : (
            t((d) => d.scan.issueLoading)
          )}
        </pre>
        <p className={styles.privacy}>{t((d) => d.scan.issueCopyPrivacy)}</p>
        <div className={styles.actions}>
          <QuietButton onClick={onClose}>{t((d) => d.common.cancel)}</QuietButton>
          <PrimaryButton onClick={onCopy} disabled={text === null}>
            {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {copied ? t((d) => d.scan.issueCopied) : t((d) => d.scan.issueCopyButton)}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
