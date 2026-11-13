// -- Icon Imports --
import { Copy, EyeOff, FileText, RotateCw } from "lucide-react";

// -- Component Imports --
import { PrimaryButton } from "../../common/PrimaryButton";
import { QuietButton } from "../../common/QuietButton";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./IssueBar.module.css";

/**
 * The sheet's bar actions: Retry, Copy list, Open log file, and Dismiss. Retry, Copy and Dismiss follow
 * the filter, so they name "these N" while a reason is on and read "all" otherwise. While a retry runs,
 * Retry and Dismiss wait and Copy stays usable.
 */
export function IssueBar({
  n,
  filtered,
  retrying,
  onRetry,
  onCopy,
  onOpenLog,
  onDismiss,
}: {
  // Rows the filter shows.
  n: number;
  filtered: boolean;
  retrying: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onOpenLog: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const retry = retrying
    ? t((d) => d.scan.issueRetrying)
    : filtered
      ? t((d) => d.scan.issueRetryThese, { n })
      : n === 1
        ? t((d) => d.scan.issueRetry)
        : t((d) => d.scan.issueRetryAll);
  const copy = filtered ? t((d) => d.scan.issueCopyThese, { n }) : t((d) => d.scan.issueCopyList);
  const dismiss = filtered
    ? t((d) => d.scan.issueDismissThese, { n })
    : n === 1
      ? t((d) => d.scan.issueDismiss)
      : t((d) => d.scan.issueDismissAll);

  return (
    <div className={styles.bar}>
      <PrimaryButton onClick={onRetry} disabled={retrying}>
        <RotateCw size={15} aria-hidden="true" />
        {retry}
      </PrimaryButton>
      <QuietButton onClick={onCopy}>
        <Copy size={15} aria-hidden="true" />
        {copy}
      </QuietButton>
      <QuietButton onClick={onOpenLog}>
        <FileText size={15} aria-hidden="true" />
        {t((d) => d.scan.issueOpenLog)}
      </QuietButton>
      <span className={styles.spacer} />
      <QuietButton onClick={onDismiss} disabled={retrying}>
        <EyeOff size={15} aria-hidden="true" />
        {dismiss}
      </QuietButton>
    </div>
  );
}
