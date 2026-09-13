// -- Component Imports --
import { FeatureRow } from "./FeatureRow";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import home from "./HomeBox.module.css";
import styles from "./SuggestionBox.module.css";

/**
 * A suggestion box: a micro-label over one continuation track, rendered as a wide feature row - the cover
 * leading with a glass play disc on hover, a caption naming the continuation and the length. With no track
 * it shows a one-line invite instead of an empty stage.
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
        <div className={styles.fill}>
          <FeatureRow track={track} context={context} onPlay={onPlay} />
        </div>
      ) : (
        <span className={`${home.invite} ${styles.invite}`}>{invite}</span>
      )}
    </div>
  );
}
