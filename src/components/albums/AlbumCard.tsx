// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { MouseEvent } from "react";

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
 * the module boundary. A single click reports the album up for the drawer; a double-click reports it
 * for the full-pane view.
 *
 * The single click is held for a double-click window before it opens the drawer, but only when it would
 * matter: with no drawer open yet, opening one reflows the grid, so an eager first click would shift the
 * second click of a double onto another card. Once a drawer is open (opening won't reflow), on keyboard
 * activation, or where there is no full-pane action at all, the click acts at once.
 */
const OPEN_DELAY_MS = 200;

export function AlbumCard({
  album,
  selected,
  drawerOpen,
  onOpen,
  onOpenFull,
}: {
  album: AlbumRow;
  selected: boolean;
  drawerOpen: boolean;
  onOpen: (albumId: number) => void;
  onOpenFull?: (albumId: number) => void;
}) {
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (openTimer.current) clearTimeout(openTimer.current);
    },
    [],
  );

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Keyboard activation (detail 0, no double-click concept), no full-pane action, or a drawer already
    // open (opening won't reflow the grid) — act at once. Otherwise wait out the double-click window so a
    // double-click is recognized before the first click opens the drawer and shifts the grid.
    if (event.detail === 0 || !onOpenFull || drawerOpen) {
      onOpen(album.id);
      return;
    }
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      onOpen(album.id);
    }, OPEN_DELAY_MS);
  };

  const handleDoubleClick = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    onOpenFull?.(album.id);
  };
  // Detail res, not thumb: the tile is 168px (more on hi-DPI) and the source cover is often larger, so a
  // 128px thumb reads crunchy against the sharp drawer and folder-view covers, which already use detail.
  const { src } = useAlbumCover(album.id, "detail");
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
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
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
