// -- Framework Imports --
import type { ReactNode } from "react";

// -- Icon Imports --
import { ListOrdered } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";

// -- Hook Imports --
import { useAlbumCover } from "../albums/useAlbumCover";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueBand.module.css";

/** The band's cover, its own component so the cover hook runs only when the block's album is known. */
function BandCover({ albumId }: { albumId: number }) {
  const { src } = useAlbumCover(albumId, "thumb");
  return (
    <span className={styles.cover}>
      <Cover src={src} alt="" />
    </span>
  );
}

/**
 * A kept block in the queue: a slim band over the block's track rows, with a rule down their left edge.
 * The band names the album (cover and title; both dropped when the album cannot be resolved), says the
 * tracks are kept together, and shows the cursor's place ("5 of 9") while the cursor is inside, else the
 * track count. It is a label: no click, no drag, no menu. `now` marks the block holding the cursor, which
 * turns the rule accent; `dim` quiets the band and the rule under a plugin stream.
 */
export function QueueBand({
  albumId,
  title,
  length,
  place,
  now,
  dim,
  children,
}: {
  albumId: number | null;
  title: string | null;
  length: number;
  /** The cursor's 1-based place inside the block while it is live, else null. */
  place: number | null;
  now: boolean;
  dim: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className={styles.block} data-now={now ? "" : undefined} data-dim={dim ? "" : undefined}>
      <div className={styles.band}>
        {albumId != null ? <BandCover albumId={albumId} /> : null}
        {title ? <span className={styles.name}>{title}</span> : null}
        <span className={styles.kept}>
          <ListOrdered size={12} strokeWidth={1.8} aria-hidden="true" />
          {t((d) => d.player.keptTogether)}
        </span>
        <span className={styles.progress}>
          {place != null
            ? t((d) => d.player.blockProgress, { n: place, total: length })
            : t((d) => d.albums.trackCount, { n: length })}
        </span>
      </div>
      <div className={styles.rows}>{children}</div>
    </div>
  );
}
