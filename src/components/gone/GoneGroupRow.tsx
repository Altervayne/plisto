// -- Icon Imports --
import { ChevronDown, Folder } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { TruncatedText } from "../common/TruncatedText/TruncatedText";

// -- Utils Imports --
import { TRACK_PAGE } from "./goneView";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { GoneGroup } from "../../state/gone/goneGroups";
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./GoneGroupRow.module.css";

/** One gone track: its title, who and what album it was filed under, and the path it can no longer be found at. */
export function GoneTrackRow({
  track,
  meta,
  flat = false,
}: {
  track: TrackRow;
  meta: string;
  flat?: boolean;
}) {
  const title = track.title_edit ?? track.raw_title ?? track.filename;
  return (
    <div className={flat ? `${styles.track} ${styles.flat}` : styles.track}>
      <div className={styles.trackText}>
        <TruncatedText text={title} className={styles.trackTitle} />
        <TruncatedText text={meta} className={styles.trackMeta} />
        <TruncatedText text={track.source_path} className={styles.trackPath} />
      </div>
    </div>
  );
}

/**
 * A folder holding gone tracks: a toggle row with its path and count and a Remove action, and the tracks
 * under it once open. A long folder lists a page of tracks at a time.
 */
export function GoneGroupRow({
  group,
  open,
  shownTracks,
  locked,
  removeBlocked,
  removeTip,
  metaOf,
  onToggle,
  onMoreTracks,
  onRemove,
}: {
  group: GoneGroup;
  open: boolean;
  /** How many of the group's tracks are listed while it is open. */
  shownTracks: number;
  locked: boolean;
  removeBlocked: boolean;
  removeTip?: string;
  metaOf: (track: TrackRow) => string;
  onToggle: () => void;
  onMoreTracks: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const hidden = Math.max(0, group.tracks.length - shownTracks);
  return (
    <div className={styles.group}>
      <div className={styles.head}>
        <button type="button" className={styles.toggle} aria-expanded={open} onClick={onToggle}>
          <span className={open ? styles.chev : `${styles.chev} ${styles.shut}`}>
            <ChevronDown size={15} strokeWidth={1.8} />
          </span>
          <span className={styles.glyph}>
            <Folder size={16} strokeWidth={1.7} />
          </span>
          <TruncatedText text={group.path} className={styles.path} />
          <span className={styles.count}>{t((d) => d.gone.tracks, { n: group.tracks.length })}</span>
        </button>
        <Tooltip label={removeTip}>
          <QuietButton destructive onClick={onRemove} disabled={locked || removeBlocked}>
            {t((d) => d.gone.removeGroup)}
          </QuietButton>
        </Tooltip>
      </div>
      {open
        ? group.tracks
            .slice(0, shownTracks)
            .map((track) => <GoneTrackRow key={track.id} track={track} meta={metaOf(track)} />)
        : null}
      {open && hidden > 0 ? (
        <div className={styles.more}>
          <QuietButton onClick={onMoreTracks}>
            {t((d) => d.gone.moreTracks, { n: Math.min(hidden, TRACK_PAGE) })}
          </QuietButton>
        </div>
      ) : null}
    </div>
  );
}
