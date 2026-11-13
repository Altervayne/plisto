// -- Icon Imports --
import { Check } from "lucide-react";

// -- State Imports --
import type { IssueNotice } from "../../../state/scanIssues";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./IssueBanner.module.css";

/**
 * The one calm line about the last action: a retry in progress, its result, a refusal while a scan runs,
 * or a failure. A check shows only when the retry left nothing unreadable; leftovers take a neutral
 * ring, since the job is not finished. Never a toast and never the danger tone.
 */
export function IssueBanner({ notice }: { notice: IssueNotice | null }) {
  const t = useT();
  if (!notice) return null;

  let text: string;
  let mark: "check" | "ring" | null = null;
  switch (notice.kind) {
    case "retrying":
      text = t((d) => d.scan.issueRetryingLine, { n: notice.n });
      break;
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
      {mark === "check" ? <Check size={15} className={styles.check} aria-hidden="true" /> : null}
      {mark === "ring" ? <span className={styles.ring} aria-hidden="true" /> : null}
      <span>{text}</span>
    </p>
  );
}
