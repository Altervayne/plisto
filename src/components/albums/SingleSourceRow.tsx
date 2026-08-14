// -- State Imports --
import { useAlbumTracks } from "../../state/organize/store";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- Style Imports --
import styles from "./SingleSourceRow.module.css";

/**
 * The single's one member, read-only: its clean title over the mono source filename and the duration.
 * An AlbumTrackRow stripped of the handle and track number - a single has nothing to reorder or number,
 * and its title/artist are edited on the release fields above, so this row is pure provenance.
 */
export function SingleSourceRow({ albumId }: { albumId: number }) {
  const tracks = useAlbumTracks(albumId);
  const row = tracks[0];
  if (!row) return null;

  const title = row.title_override ?? row.raw_title ?? row.filename;

  return (
    <div className={styles.row} data-missing={row.missing_at != null ? "" : undefined}>
      <div className={styles.main}>
        <span className={styles.title}>{title}</span>
        <span className={styles.source}>{row.filename}</span>
      </div>
      <span className={styles.dur}>{formatDuration(row.duration_secs)}</span>
    </div>
  );
}
