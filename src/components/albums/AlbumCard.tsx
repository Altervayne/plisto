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

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumCard.module.css";

/** The sub line: the lead phrase (track count for an album, "Single" for a single), plus its year. */
function subLine(album: AlbumRow, lead: string): string {
  return album.year != null ? `${lead} - ${album.year}` : lead;
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
  const missing = tracks.filter((track) => track.missing_at != null).length;
  const t = useT();
  const lead =
    album.kind === "single"
      ? t((d) => d.singles.marker)
      : t((d) => d.albums.trackCount, { n: album.track_count });

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
          <CoverBadge tone="warn" label={t((d) => d.albums.tracksMissing, { n: missing })} />
        ) : null}
      </div>
      <CardMeta
        title={album.title ?? t((d) => d.albums.untitled)}
        secondary={album.album_artist ?? ""}
        sub={subLine(album, lead)}
      />
    </button>
  );
}
