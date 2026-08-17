// -- Framework Imports --
import { memo, useMemo, useState } from "react";
import type { MouseEvent } from "react";

// -- Icon Imports --
import { Disc, FolderCog, ListChecks } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { ContextMenu } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Hook Imports --
import { useImageThumb } from "./useImageThumb";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ImageTile.module.css";

/**
 * One loose image in a folder's strip: a lazy thumbnail tile that opens the assignment chooser. A left
 * click or a right click both open the same conditional menu at the pointer, so the chooser is
 * discoverable yet mirrored for power users. The menu offers the folder cover always, the album cover
 * only when the folder resolves to one album, and the specific-tracks checklist through the parent. A
 * tile already bound as the folder's cover carries the in-use ring; a thumbnail that fails to read shows
 * the unavailable placeholder and refuses the bind - the source is gone or unreadable, never the cover.
 *
 * Memoized on primitives and stable callbacks so a bind elsewhere in the folder never re-renders the
 * whole strip: only the tile whose in-use state flips repaints.
 */
export const ImageTile = memo(function ImageTile({
  path,
  inUse,
  trackCount,
  albumId,
  onSetFolderCover,
  onSetAlbumCover,
  onSetSpecificTracks,
}: {
  path: string;
  inUse: boolean;
  trackCount: number;
  albumId: number | null;
  onSetFolderCover: (path: string) => void;
  onSetAlbumCover: (path: string) => void;
  onSetSpecificTracks: (path: string) => void;
}) {
  const { src, failed, onError } = useImageThumb(path);
  const t = useT();
  const [menu, setMenu] = useState({ open: false, x: 0, y: 0 });

  // The image's own filename, shown on hover so a tile is identifiable without opening it.
  const fileName = path.split(/[\\/]/).pop() ?? path;

  // Both a left click and a right click open the chooser at the pointer. A failed thumbnail is inert:
  // its source cannot be read, so there is nothing to bind.
  const openAt = (event: MouseEvent) => {
    event.preventDefault();
    if (failed) return;
    setMenu({ open: true, x: event.clientX, y: event.clientY });
  };

  const closeMenu = () => setMenu((prev) => ({ ...prev, open: false }));

  const entries = useMemo<MenuEntry[]>(() => {
    const items: MenuEntry[] = [
      {
        icon: <FolderCog size={16} strokeWidth={1.8} />,
        label:
          trackCount > 0
            ? t((d) => d.covers.setFolderCover, { n: trackCount })
            : t((d) => d.covers.setFolderCoverBare),
        onSelect: () => onSetFolderCover(path),
      },
    ];
    if (albumId != null) {
      items.push({
        icon: <Disc size={16} strokeWidth={1.8} />,
        label: t((d) => d.covers.setAlbumCover),
        onSelect: () => onSetAlbumCover(path),
      });
    }
    if (trackCount > 0) {
      items.push({
        icon: <ListChecks size={16} strokeWidth={1.8} />,
        label: t((d) => d.covers.setSpecificTracks),
        onSelect: () => onSetSpecificTracks(path),
      });
    }
    return items;
  }, [path, trackCount, albumId, onSetFolderCover, onSetAlbumCover, onSetSpecificTracks, t]);

  return (
    <div className={styles.tile}>
      <Tooltip label={fileName}>
        <button
          type="button"
          className={`${styles.hit} ${inUse ? styles.inUse : ""}`}
          onClick={openAt}
          onContextMenu={openAt}
          disabled={failed}
          aria-label={t((d) => d.covers.chooserLabel)}
        >
          <Cover src={failed ? null : src} interactive alt="" onError={onError} />
          {inUse ? <span className={styles.ring} aria-hidden="true" /> : null}
        </button>
      </Tooltip>
      {failed ? <span className={styles.note}>{t((d) => d.covers.unavailable)}</span> : null}

      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        onClose={closeMenu}
        items={entries}
        ariaLabel={t((d) => d.covers.chooserLabel)}
      />
    </div>
  );
});
