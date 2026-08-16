// -- Framework Imports --
import { useState } from "react";
import { createPortal } from "react-dom";

// -- Icon Imports --
import { ArrowRight } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { StaffSpinner } from "../scan/StaffSpinner";

// -- Hook Imports --
import { useImageThumb } from "./useImageThumb";
import { invalidateTrackThumb } from "./useTrackThumb";

// -- IPC Imports --
import { importTrackCover } from "../../lib/ipc";

// -- Type Imports --
import type { CoverMatch } from "./matchCovers";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CoverMatchPreview.module.css";

/**
 * The preview-then-apply modal for filename cover matching, portalled over a dim scrim like the confirm
 * dialog. It lists every image-to-track pair the match found before anything binds, so applying is a
 * deliberate second step. Apply binds each image as its track's per-track cover in turn - the index is a
 * single writer, so the binds run one at a time - and a single failed bind is skipped without stopping the
 * rest, reporting only the count that landed. An empty match set shows its own quiet state with nothing to
 * apply.
 */
export function CoverMatchPreview({
  matches,
  onClose,
  onApplied,
}: {
  matches: CoverMatch[];
  onClose: () => void;
  onApplied: (count: number) => void;
}) {
  const t = useT();
  const [applying, setApplying] = useState(false);

  const apply = async () => {
    setApplying(true);
    let applied = 0;
    for (const match of matches) {
      try {
        await importTrackCover([match.trackId], match.imagePath);
        invalidateTrackThumb(match.trackId);
        applied += 1;
      } catch {
        // A single failed bind is skipped: the track keeps its state and the rest still apply.
      }
    }
    onApplied(applied);
  };

  const empty = matches.length === 0;

  return createPortal(
    // A portal bubbles through the React tree, so a click inside would otherwise reach the host row's own
    // handlers. Seal it so applying or cancelling never fires a second action on the host.
    <div className={styles.overlay} onClick={(event) => event.stopPropagation()}>
      <div
        className={styles.backdrop}
        onClick={applying ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t((d) => d.covers.matchTitle)}
      >
        <h2 className={styles.heading}>
          {empty
            ? t((d) => d.covers.matchNone)
            : t((d) => d.covers.matchCount, { n: matches.length })}
        </h2>

        {empty ? null : (
          <ScrollArea className={styles.scroll}>
            <ul className={styles.list}>
              {matches.map((match) => (
                <MatchRow key={match.trackId} match={match} />
              ))}
            </ul>
          </ScrollArea>
        )}

        <div className={styles.foot}>
          {applying ? (
            <span className={styles.progress}>
              <StaffSpinner />
              <span className={styles.progressText}>{t((d) => d.covers.matchApplying)}</span>
            </span>
          ) : null}
          <QuietButton onClick={onClose} disabled={applying}>
            {t((d) => d.common.cancel)}
          </QuietButton>
          <PrimaryButton onClick={() => void apply()} disabled={empty || applying}>
            {t((d) => d.covers.matchApply)}
          </PrimaryButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One preview row: the matched image thumb, its basename in mono, an arrow, and the track filename. */
function MatchRow({ match }: { match: CoverMatch }) {
  const { src, failed, onError } = useImageThumb(match.imagePath);
  return (
    <li className={styles.row}>
      <span className={styles.thumb}>
        <Cover src={failed ? null : src} alt="" onError={onError} />
      </span>
      <span className={styles.image}>{match.imageName}</span>
      <ArrowRight className={styles.arrow} size={15} strokeWidth={1.8} aria-hidden="true" />
      <span className={styles.track}>{match.trackFilename}</span>
    </li>
  );
}
