// -- Icon Imports --
import { Check } from "lucide-react";

// -- State Imports --
import type { IssueNotice } from "../../../state/scanIssues";

// -- i18n Imports --
import { useLocale, useT } from "../../../i18n";

// -- Style Imports --
import styles from "./IssueBanner.module.css";

/**
 * The one calm line about the last action: a retry in progress, its result, a refusal while a scan runs,
 * or a failure. A check shows only when the retry left nothing unreadable; leftovers take a neutral
 * ring, since the job is not finished. Never a toast and never the danger tone.
 */
export function IssueBanner({ notice }: { notice: IssueNotice | null }) {
  const t = useT();
  const locale = useLocale();
  if (!notice) return null;

  let text: string;
  let mark: "check" | "ring" | null = null;
  // Percent done, set only for the progress form.
  let percent: number | null = null;
  switch (notice.kind) {
    case "retrying": {
      const progress = notice.progress;
      // A single file has nothing to count, so it keeps the plain line.
      if (progress && progress.total > 1) {
        percent = Math.min(100, Math.max(0, (progress.done / progress.total) * 100));
      }
      text =
        progress && progress.total > 1
          ? t((d) => d.scan.issueRetryProgress, {
              done: progress.done.toLocaleString(locale),
              total: progress.total.toLocaleString(locale),
            })
          : t((d) => d.scan.issueRetryingLine, { n: notice.n });
      break;
    }
    case "result": {
      const fixed = t((d) => d.scan.issueFixed, { n: notice.cleared });
      const none = notice.stillFailing === 0;
      text = none ? fixed : `${fixed}, ${t((d) => d.scan.issueStillUnreadable, { n: notice.stillFailing })}`;
      mark = none ? "check" : "ring";
      break;
    }
    case "scanRunning":
      text = t((d) => d.scan.issueScanRunning);
      break;
    case "fileWriteRunning":
      text = t((d) => d.fileWrites.busy);
      break;
    case "noLog":
      text = t((d) => d.scan.issueNoLog);
      break;
    case "unavailable":
      text = t((d) => d.scan.issueRetryUnavailable);
      break;
    case "failed":
      text = t((d) => d.scan.issueActionFailed);
      break;
  }

  return (
    <p className={`${styles.note} tabular`} role="status">
      {percent !== null ? (
        <span className={styles.bar} aria-hidden="true">
          <i style={{ width: `${percent}%` }} />
        </span>
      ) : null}
      {mark === "check" ? <Check size={15} className={styles.check} aria-hidden="true" /> : null}
      {mark === "ring" ? <span className={styles.ring} aria-hidden="true" /> : null}
      <span>{text}</span>
    </p>
  );
}
