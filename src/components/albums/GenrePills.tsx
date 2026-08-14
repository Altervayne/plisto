// -- Component Imports --
import { GenreAdder } from "../common/GenreAdder";

// -- Icon Imports --
import { Check, X } from "lucide-react";

// -- State Imports --
import {
  useAddAlbumGenre,
  useAlbumGenreAggregate,
  useCreateGenre,
  useGenres,
  useRemoveAlbumGenre,
} from "../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./GenrePills.module.css";

/**
 * The album's genres as the union of its members' per-track lists. A genre on every member reads as a
 * solid accent pill; one on only some reads dimmed and titled "on k of n". Every control is an explicit
 * bulk operator, never a silent stamp: the trailing adder adds to all, a full pill's reveal x removes
 * from all, and a partial pill promotes to all on its body or drops from all on its x. Per-track
 * divergence is edited elsewhere.
 */
export function GenrePills({ albumId }: { albumId: number }) {
  const { entries, memberCount } = useAlbumGenreAggregate(albumId);
  const genres = useGenres();
  const addAlbumGenre = useAddAlbumGenre();
  const removeAlbumGenre = useRemoveAlbumGenre();
  const createGenre = useCreateGenre();
  const t = useT();

  // The adder never re-offers a genre already on every member; a partial one stays offered to complete.
  const exclude = entries.filter((e) => e.onAll).map((e) => e.genre.id);

  // Create then add to all in one step; the store surfaces any failure, so swallow the rejection here.
  const onCreate = (name: string) => {
    void createGenre(name)
      .then((id) => addAlbumGenre(albumId, id))
      .catch(() => {});
  };

  return (
    <div className={styles.row}>
      {entries.map(({ genre, count, onAll }) =>
        onAll ? (
          <span key={genre.id} className={styles.pill}>
            <span className={styles.name}>{genre.name}</span>
            <button
              type="button"
              className={styles.remove}
              aria-label={t((d) => d.genre.pillRemove)}
              onClick={() => removeAlbumGenre(albumId, genre.id)}
            >
              <X size={12} strokeWidth={2.2} />
            </button>
          </span>
        ) : (
          <span
            key={genre.id}
            className={`${styles.pill} ${styles.partial}`}
            title={t((d) => d.genre.onSome, { k: count, n: memberCount })}
          >
            <button
              type="button"
              className={styles.apply}
              aria-label={t((d) => d.genre.applyToAll)}
              onClick={() => addAlbumGenre(albumId, genre.id)}
            >
              <span className={styles.name}>{genre.name}</span>
              <Check className={styles.applyIcon} size={12} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              className={styles.remove}
              aria-label={t((d) => d.genre.removeFromAll)}
              onClick={() => removeAlbumGenre(albumId, genre.id)}
            >
              <X size={12} strokeWidth={2.2} />
            </button>
          </span>
        ),
      )}

      <div className={styles.adder}>
        <GenreAdder
          genres={genres}
          exclude={exclude}
          onPick={(id) => addAlbumGenre(albumId, id)}
          onCreate={onCreate}
          placeholder={t((d) => d.albums.addGenre)}
        />
      </div>
    </div>
  );
}
