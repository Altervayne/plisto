// -- Framework Imports --
import { Fragment } from "react";

// -- State Imports --
import { useDuplicateCounts } from "../../state/duplicates/store";
import { useOpenDuplicates } from "../../state/shell/store";

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
 * Possible duplicates in the library close the line with their own Review link, opening the review
 * sheet. Not a toast, not a banner.
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
  const parts = scanSummaryParts(summary, t, duplicates.sets);

  return (
    <p className={`${styles.line} tabular`}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? " - " : null}
          {part.kind === "text" ? (
            part.text
          ) : part.kind === "duplicates" ? (
            <>
              {t((d) => d.duplicates.scanSummary, { n: part.n })}{" "}
              <button type="button" className={styles.review} onClick={openDuplicates}>
                {t((d) => d.tracks.reviewGone)}
              </button>
            </>
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
