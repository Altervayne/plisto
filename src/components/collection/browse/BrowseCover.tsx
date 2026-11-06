// -- Framework Imports --
import { memo, useCallback, useState } from "react";
import type { CSSProperties } from "react";

// -- Icon Imports --
import { Image as ImageIcon } from "lucide-react";

// -- Component Imports --
import { Cover } from "../../common/Cover/Cover";
import { StaffSpinner } from "../../scan/StaffSpinner";

// -- Hook Imports --
import { useAlbumCover } from "../../albums/useAlbumCover";

// -- Utils Imports --
import { recordId } from "./browseRecord";

// -- Type Imports --
import type { AlbumRow } from "../../../types";

// -- Style Imports --
import styles from "./BrowseCover.module.css";

/**
 * The focused record's cover at the detail tier, cross-faded in over the grid tier once it loads.
 * Nothing shows until then, so the grid art holds; an image already cached shows at once.
 */
function DetailArt({ albumId }: { albumId: number }) {
  const { src } = useAlbumCover(albumId, "detail");
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const armLoaded = useCallback(
    (node: HTMLImageElement | null) => {
      if (node?.complete && node.naturalWidth > 0) setLoadedSrc(node.getAttribute("src"));
    },
    [],
  );
  if (src == null) return null;
  return (
    <span className={styles.detail} data-loaded={loadedSrc === src ? "" : undefined} aria-hidden="true">
      <img
        ref={armLoaded}
        src={src}
        alt=""
        decoding="async"
        onLoad={() => setLoadedSrc(src)}
      />
    </span>
  );
}

/**
 * One record on the shelf: a listbox option holding the album's cover at the grid tier, the focused
 * one also loading the detail tier over it. A record still loading shows the staff spinner on the recess;
 * one confirmed cover-less shows a placeholder recess with a hairline edge and the title on it, so a
 * tilted run of placeholders still reads as separate records. Placement comes from the shelf as a ready transform.
 */
export const BrowseCover = memo(function BrowseCover({
  album,
  index,
  total,
  title,
  label,
  transform,
  veil,
  zIndex,
  focused,
  near,
}: {
  album: AlbumRow;
  index: number;
  total: number;
  title: string;
  /** The option's accessible name. */
  label: string;
  transform: string;
  veil: number;
  zIndex: number;
  focused: boolean;
  /** Close to the focus, where the record moves most: it gets its own compositor layer. */
  near: boolean;
}) {
  const { src, loading } = useAlbumCover(album.id, "grid");
  const style = {
    transform,
    zIndex,
    willChange: near ? "transform" : undefined,
    "--veil": veil.toFixed(3),
  } as CSSProperties;

  return (
    <div
      id={recordId(album.id)}
      role="option"
      aria-selected={focused}
      aria-label={label}
      aria-posinset={index + 1}
      aria-setsize={total}
      data-index={index}
      className={focused ? `${styles.record} ${styles.focused}` : styles.record}
      style={style}
    >
      <div className={styles.face}>
        <Cover src={src} interactive />
        {src == null && loading ? (
          <div className={styles.loading} aria-hidden="true">
            <StaffSpinner />
          </div>
        ) : null}
        {src == null && !loading ? (
          <div className={styles.placeholder} aria-hidden="true">
            <ImageIcon size={30} strokeWidth={1.6} />
            <span className={styles.placeholderTitle}>{title}</span>
          </div>
        ) : null}
        {focused ? <DetailArt albumId={album.id} /> : null}
      </div>
    </div>
  );
});
