// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";

// -- Hook Imports --
import { useTrackDetail } from "../covers/useTrackThumb";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import home from "./HomeBox.module.css";
import styles from "./SuggestionBox.module.css";

/**
 * A suggestion box: a micro-label over one continuation track - the cover leads as the dominant object,
 * then a caption beneath carrying the title, artist, a why-line naming the continuation, and the length,
 * with a resting solid-accent play disc at its trailing edge. The disc is the single solid-accent element
 * on Home; every other play affordance stays the hover-glass disc. With no track it shows a one-line
 * invite instead of an empty stage. The play disc is the click target; without a play handler it renders
 * inert.
 */
export function SuggestionBox({
  label,
  track,
  context,
  invite,
  onPlay,
}: {
  label: string;
  track: TrackRow | null;
  context?: string;
  invite: string;
  onPlay?: (track: TrackRow) => void;
}) {
  return (
    <div className={styles.suggestion}>
      <span className={home.label}>{label}</span>
      {track ? (
        <SuggestionItem track={track} context={context} onPlay={onPlay} />
      ) : (
        <span className={`${home.invite} ${styles.invite}`}>{invite}</span>
      )}
    </div>
  );
}

/**
 * The picked track: the cover object on top as the lead, then a caption beneath pairing a text column -
 * title and artist over the why-line and length - with the solid-accent play disc at its trailing edge.
 */
function SuggestionItem({
  track,
  context,
  onPlay,
}: {
  track: TrackRow;
  context?: string;
  onPlay?: (track: TrackRow) => void;
}) {
  const coverSrc = useTrackDetail(track.id);
  const title = track.title_edit ?? track.raw_title ?? track.filename;
  const artist = track.artist_edit ?? track.raw_artist ?? "";

  return (
    <div className={styles.item}>
      <div className={styles.frame}>
        <Cover src={coverSrc} alt="" />
      </div>
      <div className={styles.caption}>
        <div className={styles.textcol}>
          <span className={styles.title}>{title}</span>
          {artist ? <span className={styles.artist}>{artist}</span> : null}
          <div className={styles.meta}>
            {context ? <span className={styles.why}>{context}</span> : null}
            <span className={styles.duration}>{formatDuration(track.duration_secs)}</span>
          </div>
        </div>
        {onPlay ? (
          <button
            type="button"
            className={styles.play}
            aria-label={title}
            onClick={() => onPlay(track)}
          >
            <Play size={19} strokeWidth={2} fill="currentColor" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
