// -- Framework Imports --
import { useEffect, useMemo } from "react";

// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";

// -- Hook Imports --
import { useTrackDetail } from "../covers/useTrackThumb";

// -- State Imports --
import { useGenres, useLoadGenres } from "../../state/organize/store";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { GenreRow, TrackRow } from "../../types";

// -- Style Imports --
import styles from "./FeatureRow.module.css";

// The most genre pills a caption shows before they crowd the row.
const MAX_GENRES = 3;

/**
 * A wide feature row: the cover leads at the left bound to the row height, a rich caption fills the slack
 * - title and artist over a context line and length, with the track's genres anchored to the caption's
 * foot so the space beside a tall cover reads full. The cover is the one shadowed object, lifting under
 * the pointer with a glass play disc revealed over it, the compact grid's affordance at this scale. A gone
 * source shows no live disc.
 */
export function FeatureRow({
  track,
  context,
  onPlay,
}: {
  track: TrackRow;
  context?: string;
  onPlay?: (track: TrackRow) => void;
}) {
  const coverSrc = useTrackDetail(track.id);
  const genres = useGenres();
  const loadGenres = useLoadGenres();
  const title = track.title_edit ?? track.raw_title ?? track.filename;
  const artist = track.artist_edit ?? track.raw_artist ?? "";
  // A gone source cannot play, matching the wall: no disc, no click.
  const playable = onPlay != null && track.missing_at == null;

  // Pull the genre vocabulary once in case Organize never opened, then resolve the track's ids to names.
  useEffect(() => {
    void loadGenres();
  }, [loadGenres]);
  const genreNames = useMemo(() => {
    const byId = new Map(genres.map((g) => [g.id, g] as const));
    return track.genre_ids
      .map((id) => byId.get(id))
      .filter((g): g is GenreRow => g !== undefined)
      .slice(0, MAX_GENRES)
      .map((g) => g.name);
  }, [genres, track.genre_ids]);

  const cover = (
    <div className={styles.frame}>
      <Cover src={coverSrc} interactive alt="" />
      {playable ? (
        <span className={styles.coverPlay} aria-hidden="true">
          <Play size={18} strokeWidth={2} fill="currentColor" />
        </span>
      ) : null}
    </div>
  );

  return (
    <div className={styles.feature}>
      {playable ? (
        <button type="button" className={styles.coverButton} aria-label={title} onClick={() => onPlay?.(track)}>
          {cover}
        </button>
      ) : (
        cover
      )}
      <div className={styles.caption}>
        <span className={styles.title}>{title}</span>
        {artist ? <span className={styles.artist}>{artist}</span> : null}
        <div className={styles.meta}>
          {context ? <span className={styles.why}>{context}</span> : null}
          <span className={styles.duration}>{formatDuration(track.duration_secs)}</span>
        </div>
        {genreNames.length > 0 ? (
          <div className={styles.genres}>
            {genreNames.map((name) => (
              <span key={name} className={styles.genre}>
                {name}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
