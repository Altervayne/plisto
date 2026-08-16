// -- Framework Imports --
import { memo, useState } from "react";
import type { MouseEvent } from "react";

// -- Icon Imports --
import { Info, ListPlus, Maximize2, Trash2 } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CoverBadge } from "../common/CoverBadge/CoverBadge";
import { CardMeta } from "./CardMeta";
import { ContextMenu, useContextMenu } from "../common/ContextMenu";
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- Hook Imports --
import { useAlbumCover } from "./useAlbumCover";

// -- State Imports --
import { useAlbumTracks, useDeleteAlbum } from "../../state/organize/store";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
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
 * the module boundary. A single click opens the drawer at once; a double-click opens the full-pane
 * view.
 *
 * The first click opens the drawer and reflows the grid, so the second click of a double can land on
 * a different card. The last click is recorded at module scope, not per card, so a double is caught
 * across that shift, and onOpenFull carries the first-clicked id so the intended album still opens.
 * A double flashes the drawer open before the full view takes over, which the eager open trades for.
 */
const DOUBLE_CLICK_MS = 300;

// The last opening click across every card, so a double-click is recognized even when the first click
// reflowed the grid and the second landed on a different tile.
let lastClick: { id: number; t: number } | null = null;

export const AlbumCard = memo(function AlbumCard({
  album,
  selected,
  onOpen,
  onOpenFull,
  onAddToPlaylist,
}: {
  album: AlbumRow;
  selected: boolean;
  onOpen: (albumId: number) => void;
  onOpenFull?: (albumId: number) => void;
  onAddToPlaylist?: (trackIds: number[]) => void;
}) {
  const deleteAlbum = useDeleteAlbum();
  const menu = useContextMenu();
  // Album deletion clears the undo history, so a one-click menu delete is guarded by a confirm.
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Keyboard activation (detail 0, no double-click concept) and singles (no full pane) act at once
    // and never join a double-click.
    if (event.detail === 0 || !onOpenFull) {
      onOpen(album.id);
      return;
    }
    const now = Date.now();
    // A second click inside the window opens the full pane for the album the first click hit, which the
    // shared record still holds even if the reflow moved this tile.
    if (lastClick && now - lastClick.t < DOUBLE_CLICK_MS) {
      const firstId = lastClick.id;
      lastClick = null;
      onOpenFull(firstId);
      return;
    }
    lastClick = { id: album.id, t: now };
    onOpen(album.id);
  };

  // Detail res, not thumb: the tile is 168px (more on hi-DPI) and the source cover is often larger, so a
  // 128px thumb reads crunchy against the sharp drawer and folder-view covers, which already use detail.
  const { src } = useAlbumCover(album.id, "detail");
  const tracks = useAlbumTracks(album.id);
  const missing = tracks.filter((track) => track.missing_at != null).length;
  const t = useT();
  const single = album.kind === "single";
  const lead = single
    ? t((d) => d.singles.marker)
    : t((d) => d.albums.trackCount, { n: album.track_count });

  // The card's right-click menu, split by kind: an album offers Open (the full pane) and Delete; a single
  // has neither, only its details, an add-to-playlist, and the remove that returns its lone track to
  // unsorted. Both delete through the same album removal, styled destructive.
  const buildMenu = (): MenuEntry[] => {
    const items: MenuEntry[] = [];
    if (!single && onOpenFull) {
      items.push({
        icon: <Maximize2 size={16} strokeWidth={1.8} />,
        label: t((d) => d.albums.open),
        onSelect: () => onOpenFull(album.id),
      });
    }
    items.push({
      icon: <Info size={16} strokeWidth={1.8} />,
      label: single ? t((d) => d.singles.details) : t((d) => d.albums.details),
      onSelect: () => onOpen(album.id),
    });
    if (onAddToPlaylist) {
      items.push(
        { separator: true },
        {
          icon: <ListPlus size={16} strokeWidth={1.8} />,
          label: t((d) => d.playlists.addTo),
          onSelect: () => onAddToPlaylist(tracks.map((track) => track.track_id)),
        },
      );
    }
    items.push(
      { separator: true },
      {
        icon: <Trash2 size={16} strokeWidth={1.8} />,
        label: single ? t((d) => d.singles.remove) : t((d) => d.albums.delete),
        style: "destructive",
        onSelect: () => setConfirmDelete(true),
      },
    );
    return items;
  };

  return (
    <button
      type="button"
      className={`${styles.card} ${selected ? styles.selected : ""}`}
      aria-pressed={selected}
      onClick={handleClick}
      onContextMenu={menu.onContextMenu}
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

      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        onClose={menu.close}
        items={buildMenu()}
        ariaLabel={album.title ?? t((d) => d.albums.untitled)}
      />

      <ConfirmDialog
        open={confirmDelete}
        prompt={single ? t((d) => d.singles.removeConfirm) : t((d) => d.albums.deleteConfirm)}
        confirmLabel={single ? t((d) => d.singles.removeAction) : t((d) => d.albums.deleteAction)}
        cancelLabel={t((d) => d.common.cancel)}
        onConfirm={() => void deleteAlbum(album.id)}
        onClose={() => setConfirmDelete(false)}
        destructive
      />
    </button>
  );
});
