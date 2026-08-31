// -- Framework Imports --
import type { CSSProperties, MouseEvent } from "react";

// -- Component Imports --
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ContextMenu, useContextMenu } from "../common/ContextMenu";

// -- Icon Imports --
import { Play } from "lucide-react";

// -- Utils Imports --
import { trackColumns } from "./trackColumns";
import type { TrackColumn } from "./trackColumns";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
import type { TrackRow as TrackRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrackRow.module.css";

/** How a selection click was modified: shift extends a range, meta/ctrl toggles one. */
export interface SelectModifiers {
  shift: boolean;
  meta: boolean;
}

/** Resolves a cell to its display string, folding an absent tag to a deliberate dash. An edited
 *  column reads its effective `edit ?? raw` value through the column's resolver. */
function cellText(col: TrackColumn, track: TrackRowData): string {
  const raw = col.resolve ? col.resolve(track) : track[col.id];
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
 * One virtualized track row, positioned by the caller. Dumb: it renders cells straight from the
 * column model and reports a click. The row body opens the read-only peek; the leading checkbox is a
 * separate target that toggles selection and never opens it. The checkbox dissolves until the row is
 * hovered or a selection is active, so it is a quiet affordance rather than a permanent column. Hover
 * and the active peek show as a soft veil; a selected row carries a steadier veil.
 *
 * `buildMenu` arms the right-click menu: when passed, the row captures the context event and opens the
 * shared menu at the pointer with the entries it returns for this track. Absent, the row has no menu.
 *
 * `onPlay` arms the number cell as a hover play affordance: the raw number swaps to an accent triangle
 * on row hover, playing the track through the caller's queue. A row whose source is gone or whose format
 * is undecodable shows the triangle greyed and inert, with the reason on hover; the menu carries the
 * keyboard route. Without `onPlay` the number stays a plain cell.
 */
export function TrackRow({
  track,
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

  // The source is gone, or the format is one the engine will not decode: the triangle greys and the
  // click is dead, with the reason carried on hover.
  const playable = track.missing_at == null && track.ext !== "opus";
  const playReason =
    track.missing_at != null
      ? t((d) => d.player.fileMissing)
      : t((d) => d.player.unsupportedFormat);

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

      {trackColumns.map((col) => {
        const text = cellText(col, track);
        const empty = text === "-";

        // The number column doubles as the play affordance: the number sits in normal flow, the accent
        // triangle overlays its right text edge so the hover swap never reflows the digits.
        if (col.id === "raw_track_no" && onPlay) {
          const glyph = (
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
          );
          return (
            <span key={col.id} className={`${cellClass(col, empty)} ${styles.numCell}`}>
              <span className={styles.no}>{text}</span>
              {playable ? glyph : <Tooltip label={playReason}>{glyph}</Tooltip>}
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
