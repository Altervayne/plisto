// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CoverBadge } from "../common/CoverBadge/CoverBadge";
import { CardMeta } from "./CardMeta";

// -- Hook Imports --
import { useAlbumCover } from "./useAlbumCover";

// -- State Imports --
import { useAlbumTracks } from "../../state/organize/store";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- Style Imports --
import styles from "./AlbumCard.module.css";

/** The sub line: the album's track count, plus its year when one is set. */
function subLine(album: AlbumRow): string {
  const tracks = `${album.track_count} ${album.track_count === 1 ? "track" : "tracks"}`;
  return album.year != null ? `${tracks} - ${album.year}` : tracks;
}

/**
 * One album tile: the cover as the object, an optional warn badge over it when a member file is
 * gone, and the meta block below. The cover lifts to the pop shadow on hover and carries the accent
 * ring when selected, both driven here through the --cover-shadow hook the Cover atom reads across
 * the module boundary. A click reports the album up; opening the drawer is a later concern.
 */
export function AlbumCard({
  album,
  selected,
  onOpen,
}: {
  album: AlbumRow;
  selected: boolean;
  onOpen: (albumId: number) => void;
}) {
  const { src } = useAlbumCover(album.id);
  const tracks = useAlbumTracks(album.id);
  const missing = tracks.filter((t) => t.missing_at != null).length;

  return (
    <button
      type="button"
      className={`${styles.card} ${selected ? styles.selected : ""}`}
      aria-pressed={selected}
      onClick={() => onOpen(album.id)}
    >
      <div className={styles.frame}>
        <Cover src={src} interactive alt="" />
        {missing > 0 ? (
          <CoverBadge
            tone="warn"
            label={`${missing} ${missing === 1 ? "track" : "tracks"} missing`}
          />
        ) : null}
      </div>
      <CardMeta
        title={album.title ?? "Untitled"}
        secondary={album.album_artist ?? ""}
        sub={subLine(album)}
      />
    </button>
  );
}
