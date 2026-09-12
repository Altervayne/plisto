// -- Framework Imports --
import { useLayoutEffect, useRef, useState } from "react";

// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CardMeta } from "../albums/CardMeta";

// -- Hook Imports --
import { useTrackDetail } from "../covers/useTrackThumb";

// -- Utils Imports --
import { columnCount } from "../tracks/trackCardLayout";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./HomeBox.module.css";

// The compact cover item's width and the gutter between items, fed to the same fit math the walls use.
// Held under the surfaced card's content height so the item's caption never clips at the bottom edge.
const ITEM_WIDTH = 88;
const ITEM_GAP = 14;

/**
 * A preview box: a micro-label with an optional "See all", then a strip of the wall's cover items. It
 * measures its own width to show only as many items as fit, so a hovered cover's lift is never clipped
 * by an overflow. With no rows it shows a one-line invite rather than an empty stage. A play disc plays
 * the track when the caller wires one; without it the covers rest static.
 */
export function PreviewBox({
  label,
  rows,
  invite,
  seeAllLabel,
  onSeeAll,
  onPlay,
}: {
  label: string;
  rows: TrackRow[];
  invite: string;
  seeAllLabel?: string;
  onSeeAll?: () => void;
  onPlay?: (track: TrackRow) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(0);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => setFit(columnCount(strip.clientWidth, ITEM_WIDTH, ITEM_GAP));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  const shown = rows.slice(0, Math.max(1, fit));

  return (
    <div className={styles.preview}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        {onSeeAll && seeAllLabel ? (
          <button type="button" className={styles.seeAll} onClick={onSeeAll}>
            {seeAllLabel}
          </button>
        ) : null}
      </div>
      <div className={styles.strip} ref={stripRef}>
        {rows.length === 0 ? (
          <span className={styles.invite}>{invite}</span>
        ) : (
          shown.map((track) => (
            <PreviewItem key={track.id} track={track} onPlay={onPlay} />
          ))
        )}
      </div>
    </div>
  );
}

/** One cover item in the strip: the cover thumb over a title and artist, with a hover play disc when
 *  the track is playable and a play handler is wired. */
function PreviewItem({
  track,
  onPlay,
}: {
  track: TrackRow;
  onPlay?: (track: TrackRow) => void;
}) {
  const coverSrc = useTrackDetail(track.id);
  const title = track.title_edit ?? track.raw_title ?? track.filename;
  const artist = track.artist_edit ?? track.raw_artist ?? "";
  // A gone source cannot play, matching the wall: no disc, no click.
  const playable = onPlay != null && track.missing_at == null;

  const item = (
    <>
      <div className={styles.frame}>
        <Cover src={coverSrc} interactive alt="" />
        {playable ? (
          <span className={styles.play} aria-hidden="true">
            <Play size={16} strokeWidth={2} fill="currentColor" />
          </span>
        ) : null}
      </div>
      <CardMeta title={title} secondary={artist} />
    </>
  );

  if (!playable) {
    return <div className={styles.item}>{item}</div>;
  }
  return (
    <button
      type="button"
      className={`${styles.item} ${styles.playable}`}
      aria-label={title}
      onClick={() => onPlay?.(track)}
    >
      {item}
    </button>
  );
}
