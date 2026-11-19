// -- Component Imports --
import { PrimaryButton } from "../../common/PrimaryButton";

// -- Icon Imports --
import { Disc } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { TagProposalSummary } from "../../../state/organize/tagProposals";

// -- Style Imports --
import styles from "./TagAlbumsBand.module.css";

/**
 * The library-wide offer at the top of Unsorted: how many albums the loose tracks' tags can make, with
 * Review albums and a quiet Not now. `eyebrow` labels it as the whole library when the browser below is
 * drilled into a folder. It only offers; the review sheet does the filing.
 */
export function TagAlbumsBand({
  summary,
  eyebrow,
  onReview,
  onDismiss,
}: {
  summary: TagProposalSummary;
  eyebrow: boolean;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.band}>
      <span className={styles.glyph} aria-hidden="true">
        <Disc size={18} strokeWidth={1.8} />
      </span>
      <div className={styles.text}>
        {eyebrow ? <div className={styles.eyebrow}>{t((d) => d.tagAlbums.bandEyebrow)}</div> : null}
        <div className={styles.title}>
          {t((d) => d.tagAlbums.bandTitle, { n: summary.albumCount })}
        </div>
        <div className={styles.sub}>
          {t((d) => d.tagAlbums.bandSub, { n: summary.trackCount, m: summary.looseCount })}
        </div>
      </div>
      <div className={styles.actions}>
        <PrimaryButton onClick={onReview}>{t((d) => d.tagAlbums.bandReview)}</PrimaryButton>
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          {t((d) => d.tagAlbums.bandDismiss)}
        </button>
      </div>
    </div>
  );
}
