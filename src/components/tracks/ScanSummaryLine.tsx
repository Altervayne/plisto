// -- Framework Imports --
import { Fragment } from "react";

// -- Utils Imports --
import { scanSummaryParts } from "./scanSummaryParts";

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
 * Not a toast, not a banner.
 */
export function ScanSummaryLine({
  summary,
  onReview,
}: {
  summary: LibrarySummary;
  onReview?: () => void;
}) {
  const t = useT();
  const parts = scanSummaryParts(summary, t);

  return (
    <p className={`${styles.line} tabular`}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? " - " : null}
          {part.kind === "text" ? (
            part.text
          ) : (
            <>
              {t((d) => d.tracks.goneSummary, { n: part.n })}
              {onReview ? (
                <>
                  {" "}
                  <button type="button" className={styles.review} onClick={onReview}>
                    {t((d) => d.tracks.reviewGone)}
                  </button>
                </>
              ) : null}
            </>
          )}
        </Fragment>
      ))}
    </p>
  );
}
