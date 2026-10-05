// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { useIsLatestMerge, useUndo } from "../../state/organize/store";

// -- Type Imports --
import type { MergeReceipt } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./DuplicateSetCard.module.css";

/**
 * A set just merged, collapsed to its receipt line. Undo shows while the merge is still the latest
 * undo step, the same rule the albums-from-tags result follows.
 */
export function MergedSetCard({
  title,
  artist,
  receipt,
  filename,
  others,
  onUndo,
}: {
  title: string;
  artist: string;
  receipt: MergeReceipt;
  filename: string;
  // How many copies were folded into the kept one.
  others: number;
  onUndo: () => void;
}) {
  const t = useT();
  const undo = useUndo();
  const canUndo = useIsLatestMerge(receipt);

  return (
    <section className={`${styles.card} ${styles.merged}`} aria-label={`${title} - ${artist}`}>
      <div className={styles.head}>
        <div className={styles.names}>
          <span className={styles.title}>{title}</span>
          <span className={styles.artist}>{artist}</span>
        </div>
      </div>
      <div className={styles.receipt}>
        <p className={styles.receiptLine} role="status">
          {t((d) => d.duplicates.kept, { n: others, filename })}
        </p>
        {canUndo ? (
          <QuietButton
            onClick={() => {
              undo();
              onUndo();
            }}
          >
            {t((d) => d.common.undo)}
          </QuietButton>
        ) : null}
      </div>
    </section>
  );
}
