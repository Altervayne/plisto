// -- Framework Imports --
import { Fragment } from "react";

// -- State Imports --
import { useDuplicateCounts } from "../../state/duplicates/store";
import { useOpenScanIssues, useScanIssuesCount } from "../../state/scanIssues";
import { useOpenDuplicates } from "../../state/shell/store";

// -- Utils Imports --
import { scanSummaryParts } from "./scanSummaryParts";
import type { SummaryPart } from "./scanSummaryParts";

// -- Type Imports --
import type { LibrarySummary } from "../../state/librarySync";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ScanSummaryLine.module.css";

/**
 * The quiet, persistent line describing the last scan or background session: what landed and what
 * changed. Only the parts that carry a number show, so a clean run reads short. When files went gone
 * from disk, `onReview` arms an inline Review link beside their count that opens the gone-filtered view.
 * Unreadable files and possible duplicates carry their own Review links, opening their sheets. From the
 * unreadable count on, the line is the news: in a narrow window the text before it ellipsizes first and
 * the news with its links never clips. Not a toast, not a banner.
 */
export function ScanSummaryLine({
  summary,
  onReview,
}: {
  summary: LibrarySummary;
  onReview?: () => void;
}) {
  const t = useT();
  const duplicates = useDuplicateCounts();
  const openDuplicates = useOpenDuplicates();
  const openIssues = useOpenScanIssues();
  const liveIssues = useScanIssuesCount();

  // The standing unreadable count follows the live count, so dismissing in the sheet updates the line.
  const parts = scanSummaryParts(summary, t, duplicates.sets).flatMap((part): SummaryPart[] => {
    if (part.kind !== "issues" || part.fresh || liveIssues == null) return [part];
    return liveIssues > 0 ? [{ ...part, n: liveIssues }] : [];
  });

  const review = (onClick: () => void, label = t((d) => d.tracks.reviewGone)) => (
    <>
      {" "}
      <button type="button" className={styles.review} onClick={onClick}>
        {label}
      </button>
    </>
  );

  const render = (part: SummaryPart) => {
    if (part.kind === "text") return part.text;
    if (part.kind === "issues") {
      return (
        <>
          {part.fresh
            ? t((d) => d.scan.summaryNewUnreadable, { n: part.n })
            : t((d) => d.scan.summaryUnreadable, { n: part.n })}
          {review(openIssues, t((d) => d.scan.issueReview))}
        </>
      );
    }
    if (part.kind === "duplicates") {
      return (
        <>
          {t((d) => d.duplicates.scanSummary, { n: part.n })}
          {review(openDuplicates)}
        </>
      );
    }
    return (
      <>
        {t((d) => d.tracks.goneSummary, { n: part.n })}
        {onReview ? review(onReview) : null}
      </>
    );
  };

  const joined = (group: SummaryPart[]) =>
    group.map((part, i) => (
      <Fragment key={i}>
        {i > 0 ? " - " : null}
        {render(part)}
      </Fragment>
    ));

  const at = parts.findIndex((part) => part.kind === "issues");
  if (at < 0) return <p className={`${styles.line} tabular`}>{joined(parts)}</p>;

  return (
    <p className={`${styles.line} ${styles.split} tabular`}>
      {at > 0 ? <span className={styles.lead}>{joined(parts.slice(0, at))} - </span> : null}
      <span className={styles.news}>{joined(parts.slice(at))}</span>
    </p>
  );
}
