// -- Framework Imports --
import type { CSSProperties, MouseEvent } from "react";

// -- Component Imports --
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ContextMenu, useContextMenu } from "../common/ContextMenu";

// -- Icon Imports --
import { Play } from "lucide-react";

// -- Utils Imports --
import { trackColumns } from "./trackColumns";
import { EMPTY_INDEX } from "./trackFacets";
import type { TrackColumn } from "./trackColumns";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
import type { AlbumRow, TrackRow as TrackRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrackRow.module.css";

/** How a selection click was modified: shift extends a range, meta/ctrl toggles one. */
export interface SelectModifiers {
  shift: boolean;
  meta: boolean;
}

/** Resolves a cell to its display string, folding an absent tag to a deliberate dash. A resolved column
 *  reads its effective value through the column's resolver, joining the album index where it applies. */
function cellText(col: TrackColumn, track: TrackRowData, index: Map<number, AlbumRow>): string {
  const raw = col.resolve ? col.resolve(track, index) : track[col.id];
  if (col.format) return col.format(raw);
  if (raw == null || raw === "") return "-";
  return String(raw);
}

/** Composes the cell class from the column's ink, alignment, and face; a dash always reads quiet. */
function cellClass(col: TrackColumn, empty: boolean): string {
  const parts = [styles.cell, styles[col.ink], styles[col.align]];
  if (col.mono) parts.push(styles.mono);
  if (col.tabular) parts.push(styles.tabular);
  if (col.upper) parts.push(styles.upper);
  if (empty) parts.push(styles.empty);
  return parts.join(" ");
}

/**
 * One virtualized track row, positioned by the caller. Dumb: it renders cells from the column model and
 * reports a click. The row body opens the read-only peek; the leading checkbox is a separate target that
 * toggles selection. The checkbox dissolves until the row is hovered or a selection is active. Hover and
 * the active peek show as a soft veil; a selected row carries a steadier one.
 *
 * `buildMenu` arms the right-click menu, opening the shared menu at the pointer with the entries it
 * returns. `onPlay` arms the number cell as a hover play affordance: the number swaps to an accent
 * triangle on hover, playing the track through the caller's queue; a gone source greys it inert, with the
 * reason on hover. Without either the row keeps its plain form.
 */
export function TrackRow({
  track,
  columns = trackColumns,
  albumIndex = EMPTY_INDEX,
  active,
  selected,
  selecting,
  style,
  onSelect,
  onToggle,
  onPlay,
  buildMenu,
}: {
  track: TrackRowData;
  columns?: TrackColumn[];
  // The track-to-album join, so a member's album, album-artist, and year cells read the container's
  // fields; the file browser leaves it at the empty default for loose edit-over-raw.
  albumIndex?: Map<number, AlbumRow>;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  style: CSSProperties;
  onSelect: (track: TrackRowData) => void;
  onToggle: (trackId: number, modifiers: SelectModifiers) => void;
  onPlay?: (track: TrackRowData) => void;
  buildMenu?: (track: TrackRowData) => MenuEntry[];
}) {
  const t = useT();
  const menu = useContextMenu();

  // The source is gone: the triangle greys and the click is dead, with the reason carried on hover.
  const playable = track.missing_at == null;
  const playReason = t((d) => d.player.fileMissing);

  const toggle = (e: MouseEvent) => {
    // Keep the peek from opening: the checkbox owns this click.
    e.stopPropagation();
    onToggle(track.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  };

  const rowClass = [styles.row, active ? styles.active : "", selected ? styles.selected : "", selecting ? styles.selecting : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rowClass}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={track.raw_title ?? track.filename}
      onClick={() => onSelect(track)}
      onContextMenu={buildMenu ? menu.onContextMenu : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(track);
        }
      }}
    >
      <button
        type="button"
        className={styles.check}
        role="checkbox"
        aria-checked={selected}
        aria-label={selected ? t((d) => d.tracks.deselectTrack) : t((d) => d.tracks.selectTrack)}
        onClick={toggle}
      >
        <span className={styles.tick} aria-hidden="true" />
      </button>

      {columns.map((col) => {
        const text = cellText(col, track, albumIndex);
        const empty = text === "-";

        // The play triangle, armed only when the caller passes onPlay. A gone source greys it inert with
        // its reason on hover.
        const glyph = onPlay ? (
          <span
            className={playable ? styles.play : `${styles.play} ${styles.playOff}`}
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              if (playable) onPlay(track);
            }}
          >
            <Play size={12} strokeWidth={2} fill="currentColor" />
          </span>
        ) : null;
        const armedGlyph =
          glyph == null || playable ? glyph : <Tooltip label={playReason}>{glyph}</Tooltip>;

        // The lead gutter carries the hover play triangle alone: blank at rest, no value beneath it.
        if (col.affordance) {
          return (
            <span key={col.id} className={`${cellClass(col, true)} ${styles.numCell}`}>
              {armedGlyph}
            </span>
          );
        }

        // The number column doubles as the play affordance: the number sits in normal flow, the accent
        // triangle overlays its right text edge so the hover swap never reflows the digits.
        if (col.id === "raw_track_no" && glyph) {
          return (
            <span key={col.id} className={`${cellClass(col, empty)} ${styles.numCell}`}>
              <span className={styles.no}>{text}</span>
              {armedGlyph}
            </span>
          );
        }

        const cell = (
          <span key={col.id} className={cellClass(col, empty)}>
            {text}
          </span>
        );
        // A dash is a deliberate absence, not a truncation, so it earns no tooltip.
        return empty ? (
          cell
        ) : (
          <Tooltip key={col.id} label={text}>
            {cell}
          </Tooltip>
        );
      })}

      {buildMenu ? (
        <ContextMenu
          open={menu.open}
          x={menu.x}
          y={menu.y}
          onClose={menu.close}
          items={buildMenu(track)}
          ariaLabel={track.raw_title ?? track.filename}
        />
      ) : null}
    </div>
  );
}
