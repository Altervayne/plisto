// -- Framework Imports --
import { useEffect, useMemo } from "react";

// -- Component Imports --
import { GenreAdder } from "../common/GenreAdder";

// -- Icon Imports --
import { X } from "lucide-react";

// -- State Imports --
import { useSetTrackGenres } from "../../state/store";
import { useCreateGenre, useGenres, useLoadGenres } from "../../state/organize/store";

// -- Type Imports --
import type { GenreRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrackGenres.module.css";

/**
 * The per-track genre editor: the track's genres as removable pills over a trailing adder. The
 * vocabulary is global, so pull it once on mount in case the Organize view never opened. Genre is
 * edited through the Files-view's own optimistic path; a pick or a create replaces the whole list.
 */
export function TrackGenres({ trackId, genreIds }: { trackId: number; genreIds: number[] }) {
  const genres = useGenres();
  const setTrackGenres = useSetTrackGenres();
  const createGenre = useCreateGenre();
  const loadGenres = useLoadGenres();
  const t = useT();

  useEffect(() => {
    void loadGenres();
  }, [loadGenres]);

  // Resolve the id list to vocabulary rows off shallow-stable inputs, deriving with useMemo so the
  // fresh array never loops a subscription. An id with no vocabulary match is dropped.
  const pills = useMemo(() => {
    const byId = new Map(genres.map((g) => [g.id, g] as const));
    return genreIds.map((id) => byId.get(id)).filter((g): g is GenreRow => g !== undefined);
  }, [genres, genreIds]);

  const commit = (ids: number[]) => void setTrackGenres(trackId, ids);

  // Create then add the returned id; the store surfaces any failure, so swallow the rejection here.
  const onCreate = (name: string) => {
    void createGenre(name)
      .then((id) => setTrackGenres(trackId, [...genreIds, id]))
      .catch(() => {});
  };

  return (
    <div className={styles.row}>
      {pills.map((genre) => (
        <span key={genre.id} className={styles.pill}>
          <span className={styles.name}>{genre.name}</span>
          <button
            type="button"
            className={styles.remove}
            aria-label={t((d) => d.genre.pillRemove)}
            onClick={() => commit(genreIds.filter((id) => id !== genre.id))}
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </span>
      ))}

      <div className={styles.adder}>
        <GenreAdder
          genres={genres}
          exclude={genreIds}
          onPick={(id) => commit([...genreIds, id])}
          onCreate={onCreate}
          placeholder={t((d) => d.albums.addGenre)}
        />
      </div>
    </div>
  );
}
