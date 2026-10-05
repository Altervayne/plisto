// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { StaffSpinner } from "../scan/StaffSpinner";
import { DismissedSection } from "./DismissedSection";
import { DuplicateSetCard } from "./DuplicateSetCard";
import { MergedSetCard } from "./MergedSetCard";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";
import { useDuplicatesReview } from "./useDuplicatesReview";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./DuplicatesSheet.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/**
 * The possible-duplicates review, a dimmed modal over the library. Each set lists its copies side by
 * side; Keep this one folds the others into the chosen copy and leaves a receipt line with Undo, Not
 * duplicates hides the set. Dismissed sets wait at the bottom for Restore. Files are never touched.
 * Portals to the body and closes on Escape, the backdrop, or Close.
 */
export function DuplicatesSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const review = useDuplicatesReview();

  // Own the card's lifetime so a close plays its exit before the host drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (!card.mounted) return null;

  const title = t((d) => d.duplicates.title);
  const summary = t((d) => d.duplicates.summary, {
    sets: t((d) => d.duplicates.sets, { n: review.sets }),
    files: t((d) => d.duplicates.files, { n: review.files }),
  });

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{title}</h2>
            {review.sets > 0 ? <p className={styles.summary}>{summary}</p> : null}
            <p className={styles.safety}>{t((d) => d.duplicates.safety)}</p>
          </div>
          <QuietButton onClick={requestClose} aria-label={t((d) => d.common.close)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        {!review.loaded ? (
          <div className={styles.loading}>
            <StaffSpinner />
          </div>
        ) : (
          <ScrollArea className={styles.list}>
            <div className={styles.sets}>
              {review.items.length === 0 ? (
                <p className={styles.empty}>
                  {review.dismissed.length > 0
                    ? t((d) => d.duplicates.emptyResolved)
                    : t((d) => d.duplicates.empty)}
                </p>
              ) : (
                review.items.map((item) =>
                  item.kind === "set" ? (
                    <DuplicateSetCard
                      key={item.group.key}
                      group={item.group}
                      copies={item.copies}
                      onMerged={(receipt, filename) =>
                        review.markMerged(item.group, receipt, filename)
                      }
                    />
                  ) : (
                    <MergedSetCard
                      key={`merged:${item.group.key}`}
                      title={item.group.title}
                      artist={item.group.artist}
                      receipt={item.receipt}
                      filename={item.filename}
                      others={item.group.trackIds.length - 1}
                      onUndo={() => review.dropMerged(item.group.key)}
                    />
                  ),
                )
              )}
              <DismissedSection groups={review.dismissed} onRestore={review.restore} />
            </div>
          </ScrollArea>
        )}
      </div>
    </div>,
    document.body,
  );
}
