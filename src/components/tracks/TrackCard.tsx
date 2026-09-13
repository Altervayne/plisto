// -- Framework Imports --
import { memo } from "react";
import type { MouseEvent } from "react";

// -- Icon Imports --
import { Check, Play } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CardMeta } from "../albums/CardMeta";
import { ContextMenu, useContextMenu } from "../common/ContextMenu";

// -- Hook Imports --
import { useTrackDetail } from "../covers/useTrackThumb";

// -- Utils Imports --
import { resolveTrackAlbum } from "./trackAlbum";
import { EMPTY_INDEX } from "./trackFacets";

// -- Type Imports --
import type { SelectModifiers } from "./TrackRow";
import type { MenuEntry } from "../common/ContextMenu";
import type { AlbumRow, TrackRow as TrackRowData } from "../../types";

// -- Style Imports --
import styles from "./TrackCard.module.css";

/**
 * One track tile: the cover as the object over a title, artist, and album. The album grounds a browse by
 * where a track sits rather than its runtime, which the list column keeps. It carries the same
 * affordance grammar as the album card - the cover lifts on hover and takes the accent ring when peeked
 * or picked, a hover-play disc queues the view from this track, and a hover pick ring toggles selection.
 * A plain click opens the read-only peek; a modified click drives multi-select. Feeds the All Tracks
 * wall, so it reads from the same rows the list does; selection and the right-click menu are the caller's.
 */
export const TrackCard = memo(function TrackCard({
  track,
  albumIndex = EMPTY_INDEX,
  active,
  checked,
  selecting,
  onOpen,
  onToggleSelect,
  onPlay,
  buildMenu,
}: {
  track: TrackRowData;
  // The track-to-album join, so a member's album line reads its container's title; the empty default
  // keeps the loose edit-over-raw everywhere else.
  albumIndex?: Map<number, AlbumRow>;
  active: boolean;
  checked: boolean;
  // A selection is live somewhere on the wall: every tile shows its ring, so picking more is a plain
  // click rather than a hover hunt.
  selecting: boolean;
  onOpen: (track: TrackRowData) => void;
  onToggleSelect: (trackId: number, mods: SelectModifiers) => void;
  onPlay?: (track: TrackRowData) => void;
  buildMenu: (track: TrackRowData) => MenuEntry[];
}) {
  const menu = useContextMenu();
  // Detail res, not thumb: the tile is 168px (more on hi-DPI), so a 128px thumb reads crunchy - the album
  // wall and drawer already use detail for the same reason. Still the cached cover-only read, not the full
  // cover hook, whose per-card candidate scan would fire for data a card never shows.
  const coverSrc = useTrackDetail(track.id);

  // The source is gone: the play disc greys and its click is dead, mirroring the row's triangle.
  const playable = track.missing_at == null;

  const title = track.title_edit ?? track.raw_title;
  const artist = track.artist_edit ?? track.raw_artist;
  const album = resolveTrackAlbum(track, albumIndex);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // A modified click drives multi-select rather than opening: ctrl/cmd toggles, shift extends the range.
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      onToggleSelect(track.id, { meta: event.ctrlKey || event.metaKey, shift: event.shiftKey });
      return;
    }
    onOpen(track);
  };

  const cardClass = [styles.card, active ? styles.selected : "", checked ? styles.checked : "", selecting ? styles.picking : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={cardClass}
      aria-pressed={checked || active}
      aria-label={title ?? track.filename}
      onClick={handleClick}
      onContextMenu={menu.onContextMenu}
    >
      <div className={styles.frame}>
        <Cover src={coverSrc} interactive alt="" />
        {/* The play affordance: a disc centered on the cover, fading in on hover. Its own click target -
         * it plays the view from this track and stops the card's open. Gone while the player is off, inert
         * when the source is missing. */}
        {onPlay ? (
          <span
            className={playable ? styles.play : `${styles.play} ${styles.playOff}`}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              if (playable) onPlay(track);
            }}
          >
            <Play size={20} strokeWidth={2} fill="currentColor" />
          </span>
        ) : null}
        {/* The select affordance: a hollow ring fading in on hover, filling to the accent check once picked.
         * Its own click target - a plain click toggles this tile, stopping the card's open. */}
        <span
          className={styles.pick}
          aria-hidden="true"
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect(track.id, { meta: false, shift: false });
          }}
        >
          {checked ? <Check size={14} strokeWidth={3} /> : null}
        </span>
      </div>
      <CardMeta
        title={title ?? track.filename}
        secondary={artist ?? ""}
        sub={album ?? ""}
      />

      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        onClose={menu.close}
        items={buildMenu(track)}
        ariaLabel={title ?? track.filename}
      />
    </button>
  );
});
