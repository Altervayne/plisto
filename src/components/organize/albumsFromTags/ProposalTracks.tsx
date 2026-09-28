// -- State Imports --
import { effectiveDisc } from "../../../state/organize/groupByAlbumTags";

// -- Type Imports --
import type { TrackRow } from "../../../types";

// -- Style Imports --
import styles from "./ProposalRow.module.css";

/** The real-case name of the folder a track sits in. */
function folderName(track: TrackRow): string {
  const parts = (track.display_path ?? track.source_path).split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

/**
 * A proposal's tracks in play order: disc and track number (the disc only on a multi-disc set), title,
 * and folder. An unnumbered track shows a dash where its number would be.
 */
export function ProposalTracks({ tracks, multiDisc }: { tracks: TrackRow[]; multiDisc: boolean }) {
  return (
    <ol className={styles.tracks}>
      {tracks.map((track) => {
        const no = track.raw_track_no != null ? String(track.raw_track_no) : "-";
        const title = track.title_edit ?? track.raw_title ?? track.filename;
        return (
          <li
            key={track.id}
            className={styles.track}
            data-missing={track.missing_at != null ? "" : undefined}
          >
            <span className={styles.no}>{multiDisc ? `${effectiveDisc(track)}.${no}` : no}</span>
            <span className={styles.trackTitle} title={title}>
              {title}
            </span>
            <span className={styles.folder}>{folderName(track)}</span>
          </li>
        );
      })}
    </ol>
  );
}
