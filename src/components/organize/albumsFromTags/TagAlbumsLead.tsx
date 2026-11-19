// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./TagAlbumsLead.module.css";

/** The one-line offer above a Home preview's rows: how many albums the tags can make, and Review. */
export function TagAlbumsLead({ albumCount, onReview }: { albumCount: number; onReview: () => void }) {
  const t = useT();
  return (
    <div className={styles.lead}>
      <span className={styles.message}>{t((d) => d.tagAlbums.leadLine, { n: albumCount })}</span>
      <button type="button" className={styles.review} data-arrange-hidden="" onClick={onReview}>
        {t((d) => d.tagAlbums.leadReview)}
      </button>
    </div>
  );
}
