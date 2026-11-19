// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./TagAlbumsPointer.module.css";

/** The one-line pointer under an empty Albums or Singles page: what the tags can make, and Review albums. */
export function TagAlbumsPointer({ albumCount, onReview }: { albumCount: number; onReview: () => void }) {
  const t = useT();
  return (
    <p className={styles.pointer}>
      {t((d) => d.tagAlbums.pointer, { n: albumCount })}
      <button type="button" className={styles.review} onClick={onReview}>
        {t((d) => d.tagAlbums.bandReview)}
      </button>
    </p>
  );
}
