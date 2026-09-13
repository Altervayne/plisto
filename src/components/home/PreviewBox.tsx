// -- Framework Imports --
import { useLayoutEffect, useRef, useState } from "react";

// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CardMeta } from "../albums/CardMeta";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { FeatureRow } from "./FeatureRow";

// -- Hook Imports --
import { useTrackDetail } from "../covers/useTrackThumb";

// -- State Imports --
import { useAlbumIndex } from "../../state/organize/store";

// -- Utils Imports --
import { columnCount } from "../tracks/trackCardLayout";
import { resolveTrackAlbum } from "../tracks/trackAlbum";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./HomeBox.module.css";

// The compact cover item's width and the gutter between items, fed to the same fit math the walls use.
// Held under the surfaced card's content height so the item's caption never clips at the bottom edge.
const ITEM_WIDTH = 88;
const ITEM_GAP = 14;
// One item's fixed height: the square cover (ITEM_WIDTH), its 8px gap, and the two-line caption. A
// constant, not a measured value, so the row-fit holds even before the async rows have mounted an item.
const ITEM_HEIGHT = 126;
// The feature row's cover height, fixed so the hero reads the same size in every tall box, and the least
// gap it keeps to the strip. A calm divider sits in the slack the whole grid rows leave, so the space
// fills as margin rather than a stranded gap under the strip.
const FEATURE_HEIGHT = 150;
const FEATURE_GAP = 16;

/**
 * A preview box: a micro-label with an optional "See all", then the wall's cover items. It measures its
 * body height and, when a tall box has the room for both, leads with a wide feature row over the compact
 * strip; a short box shows the strip alone. The strip measures its own remaining width and height to show
 * only as many items as fit, so a hovered cover's lift is never clipped by an overflow. With no rows it
 * shows a one-line invite rather than an empty stage. A play disc plays the track when the caller wires
 * one; without it the covers rest static.
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [bodyHeight, setBodyHeight] = useState(0);
  const albumIndex = useAlbumIndex();

  // The body holds the feature over the strip and fills the card under the head. Measuring it, not the
  // strip, gives a stable read: the feature it gates never changes the body's own size, so it never
  // oscillates, and the width and height both drive the grid off one measure.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      setBodyWidth(body.clientWidth);
      setBodyHeight(body.clientHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const cols = Math.max(1, columnCount(bodyWidth, ITEM_WIDTH, ITEM_GAP));
  // Lead with a feature only when there are at least two tracks and the body holds the feature, its gap,
  // and one strip row; otherwise a tall box would trade its whole strip for one big cover.
  const featureMode = rows.length >= 2 && bodyHeight >= FEATURE_HEIGHT + FEATURE_GAP + ITEM_HEIGHT;
  // Fit whole strip rows into the space left below the feature; the body then spaces the feature, the
  // divider, and the strip apart, so the slack lands as margin around the divider, not a bottom gap.
  const gridSpace = featureMode ? bodyHeight - FEATURE_HEIGHT - FEATURE_GAP : bodyHeight;
  const gridRows = Math.max(1, Math.floor((gridSpace + ITEM_GAP) / (ITEM_HEIGHT + ITEM_GAP)));
  // The feature takes the first row, so the strip fills from the second; a short box strips them all.
  const stripRows = featureMode ? rows.slice(1) : rows;
  const shown = stripRows.slice(0, cols * gridRows);

  return (
    <div className={styles.preview}>
      <div className={styles.head}>
        <span className={styles.label}>{label}</span>
        {onSeeAll && seeAllLabel ? (
          // Inert while arranging, where the box is a drag object - arrange hides it so it never sits
          // under the remove control. Marked, not conditioned on arrange, so the content stays unaware.
          <button type="button" className={styles.seeAll} data-arrange-hidden="" onClick={onSeeAll}>
            {seeAllLabel}
          </button>
        ) : null}
      </div>
      <div className={`${styles.body} ${featureMode ? styles.bodyFeatured : ""}`} ref={bodyRef}>
        {featureMode ? (
          <>
            <div className={styles.featureBand} style={{ height: FEATURE_HEIGHT }}>
              <FeatureRow
                track={rows[0]}
                context={resolveTrackAlbum(rows[0], albumIndex) ?? undefined}
                onPlay={onPlay}
              />
            </div>
            <span className={styles.divider} aria-hidden="true" />
          </>
        ) : null}
        <div className={`${styles.strip} ${featureMode ? "" : styles.stripGrow}`}>
          {rows.length === 0 ? (
            <span className={styles.invite}>{invite}</span>
          ) : (
            shown.map((track) => <PreviewItem key={track.id} track={track} onPlay={onPlay} />)
          )}
        </div>
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
  // The filed album, resolved as the wall reads it, so a member names its container rather than its own tag.
  const album = resolveTrackAlbum(track, useAlbumIndex());
  // A gone source cannot play, matching the wall: no disc, no click.
  const playable = onPlay != null && track.missing_at == null;

  // The hover bubble carries the track's full info, since the compact caption clips both lines.
  const tip = (
    <span className={styles.tip}>
      <span className={styles.tipTitle}>{title}</span>
      {artist ? <span className={styles.tipLine}>{artist}</span> : null}
      {album ? <span className={styles.tipLine}>{album}</span> : null}
    </span>
  );

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

  const shell = !playable ? (
    <div className={styles.item}>{item}</div>
  ) : (
    <button
      type="button"
      className={`${styles.item} ${styles.playable}`}
      aria-label={title}
      onClick={() => onPlay?.(track)}
    >
      {item}
    </button>
  );

  return <Tooltip label={tip}>{shell}</Tooltip>;
}
