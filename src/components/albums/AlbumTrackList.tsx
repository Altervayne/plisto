// -- Component Imports --
import { AlbumTrackRow } from "./AlbumTrackRow";

// -- State Imports --
import { useAlbumTracks } from "../../state/organize/store";

// -- Style Imports --
import styles from "./AlbumTrackList.module.css";

/**
 * The album's tracks in order. Empty is offered plainly - an album can hold no tracks (delete or keep).
 * Reorder by drag is a later concern; this lays the rows out in their stored track order.
 */
export function AlbumTrackList({ albumId }: { albumId: number }) {
  const tracks = useAlbumTracks(albumId);

  if (tracks.length === 0) {
    return <p className={styles.empty}>No tracks in this album.</p>;
  }

  return (
    <div className={styles.list}>
      {tracks.map((row) => (
        <AlbumTrackRow key={row.track_id} row={row} />
      ))}
    </div>
  );
}
