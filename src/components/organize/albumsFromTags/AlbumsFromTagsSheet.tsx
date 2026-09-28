// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { PrimaryButton } from "../../common/PrimaryButton";
import { QuietButton } from "../../common/QuietButton";
import { ScrollArea } from "../../common/ScrollArea/ScrollArea";
import { SegmentedControl } from "../../common/SegmentedControl";
import { ProposalRow } from "./ProposalRow";

// -- Hook Imports --
import { useMountTransition } from "../../../hooks/useMountTransition";
import { useTagAlbumReview } from "./useTagAlbumReview";

// -- State Imports --
import { useIsLatestTagBatch, useUndo } from "../../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { Translate } from "../../../i18n";
import type { TagAlbumReceipt } from "../../../types";
import type { ReviewFilter } from "./useTagAlbumReview";

// -- Style Imports --
import styles from "./AlbumsFromTagsSheet.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/** The primary button's label for what the checked rows will write. */
function commitLabel(t: Translate, counts: { created: number; extended: number }): string {
  if (counts.created > 0 && counts.extended > 0) {
    return t((d) => d.tagAlbums.createAndAdd, { n: counts.created, m: counts.extended });
  }
  if (counts.extended > 0) return t((d) => d.tagAlbums.addOnly, { n: counts.extended });
  return t((d) => d.tagAlbums.create, { n: counts.created });
}

/** The result line for a landed batch: albums created, tracks added to existing albums, or both. */
function resultLine(t: Translate, receipt: TagAlbumReceipt): string {
  const created = receipt.created.length;
  const added = receipt.extended.reduce((sum, e) => sum + e.members.length, 0);
  const tracks = t((d) => d.tagAlbums.trackCount, { n: added });
  const albums = t((d) => d.tagAlbums.albumCount, { n: receipt.extended.length });
  if (created > 0 && added > 0) return t((d) => d.tagAlbums.resultBoth, { n: created, tracks, albums });
  if (added > 0) return t((d) => d.tagAlbums.resultAdded, { tracks, albums });
  return t((d) => d.tagAlbums.resultCreated, { n: created });
}

/**
 * The albums-from-tags review, a dimmed modal over Unsorted. It proposes one album per shared album tag
 * among the loose tracks in scope, each row checked unless it needs a look, and writes the checked rows
 * in one batch. The result stays until dismissed and offers Undo while the batch is still the latest
 * step. While the batch writes, Escape and the backdrop do nothing. Portals to the body.
 */
export function AlbumsFromTagsSheet({
  scopeId,
  folderName,
  onClose,
  onShowAlbums,
}: {
  scopeId: string;
  folderName: string | null;
  onClose: () => void;
  onShowAlbums: () => void;
}) {
  const t = useT();
  const review = useTagAlbumReview(scopeId);
  const undo = useUndo();
  const canUndo = useIsLatestTagBatch(review.receipt);
  const { preview, pending } = review;

  // Own the card's lifetime so a close plays its exit before the parent drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => {
    if (!pending) setOpen(false);
  }, [pending]);
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

  const title = t((d) => d.tagAlbums.title);
  const tracks = t((d) => d.tagAlbums.trackCount, { n: preview.trackCount });
  const scopeLine =
    folderName != null
      ? t((d) => d.tagAlbums.scopeFolder, {
          n: preview.proposals.length,
          tracks,
          folder: folderName,
        })
      : t((d) => d.tagAlbums.scopeLibrary, { n: preview.proposals.length, tracks });
  const leftOut = [
    preview.looseCount > 0 ? t((d) => d.tagAlbums.stayLoose, { n: preview.looseCount }) : null,
    preview.skippedMissing > 0
      ? t((d) => d.tagAlbums.skippedMissing, { n: preview.skippedMissing })
      : null,
  ].filter((line): line is string => line != null);

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{title}</h2>
            {review.receipt ? null : (
              <>
                <p className={styles.summary}>{scopeLine}</p>
                {leftOut.length > 0 ? <p className={styles.quiet}>{leftOut.join(" - ")}</p> : null}
              </>
            )}
          </div>
          <QuietButton onClick={requestClose} disabled={pending} aria-label={t((d) => d.common.close)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        {review.receipt ? (
          <div className={styles.result}>
            <p className={styles.resultLine}>{resultLine(t, review.receipt)}</p>
            <div className={styles.resultActions}>
              <PrimaryButton onClick={requestClose}>{t((d) => d.tagAlbums.done)}</PrimaryButton>
              {canUndo ? (
                <QuietButton
                  onClick={() => {
                    undo();
                    requestClose();
                  }}
                >
                  {t((d) => d.common.undo)}
                </QuietButton>
              ) : null}
              <QuietButton onClick={onShowAlbums}>{t((d) => d.tagAlbums.showInAlbums)}</QuietButton>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.toolbar}>
              <label className={styles.selectAll}>
                <input
                  type="checkbox"
                  className={styles.check}
                  checked={review.allChecked}
                  disabled={!review.canSelectAll || pending}
                  onChange={review.toggleAll}
                />
                {t((d) => d.tagAlbums.selectAll)}
              </label>
              <SegmentedControl<ReviewFilter>
                label={t((d) => d.tagAlbums.filterLabel)}
                value={review.filter}
                onChange={review.setFilter}
                segments={[
                  {
                    value: "all",
                    label: t((d) => d.tagAlbums.filterAll, { n: preview.proposals.length }),
                  },
                  { value: "look", label: t((d) => d.tagAlbums.filterLook, { n: review.lookCount }) },
                ]}
              />
            </div>

            {review.notice ? (
              <p className={styles.notice} role="status">
                {review.notice === "stale"
                  ? t((d) => d.tagAlbums.stale)
                  : t((d) => d.tagAlbums.error)}
              </p>
            ) : null}

            {review.visible.length === 0 ? (
              <p className={styles.empty}>{t((d) => d.tagAlbums.empty)}</p>
            ) : (
              <ScrollArea className={styles.list}>
                <div className={styles.rows} role="group" aria-label={title}>
                  {review.visible.map((proposal) => (
                    <ProposalRow
                      key={proposal.key}
                      proposal={proposal}
                      checked={review.checked.has(proposal.key)}
                      choice={review.choiceOf(proposal)}
                      disabled={pending}
                      onToggle={() => review.toggle(proposal.key)}
                      onChoose={(choice) => review.choose(proposal, choice)}
                    />
                  ))}
                </div>
              </ScrollArea>
            )}

            <div className={styles.footer}>
              <span className={styles.safety}>{t((d) => d.tagAlbums.safety)}</span>
              <PrimaryButton onClick={() => void review.commit()} disabled={!review.canCommit}>
                {pending ? t((d) => d.tagAlbums.creating) : commitLabel(t, review.counts)}
              </PrimaryButton>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
