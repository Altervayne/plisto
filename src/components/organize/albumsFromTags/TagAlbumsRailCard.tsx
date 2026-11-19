// -- Icon Imports --
import { Disc } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./TagAlbumsRailCard.module.css";

/** The small rail card under the Files rows: how many albums the tags can make, opening the review. */
export function TagAlbumsRailCard({ albumCount, onReview }: { albumCount: number; onReview: () => void }) {
  const t = useT();
  return (
    <button type="button" className={styles.card} onClick={onReview}>
      <span className={styles.glyph} aria-hidden="true">
        <Disc size={17} strokeWidth={1.8} />
      </span>
      <span className={styles.text}>
        <span className={styles.title}>{t((d) => d.tagAlbums.railTitle, { n: albumCount })}</span>
        <span className={styles.go}>{t((d) => d.tagAlbums.leadReview)}</span>
      </span>
    </button>
  );
}
