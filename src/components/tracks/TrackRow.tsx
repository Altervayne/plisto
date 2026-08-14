// -- Framework Imports --
import type { CSSProperties, MouseEvent } from "react";

// -- Utils Imports --
import { trackColumns } from "./trackColumns";
import type { TrackColumn } from "./trackColumns";

// -- Type Imports --
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

/** Resolves a cell to its display string, folding an absent tag to a deliberate dash. */
function cellText(col: TrackColumn, track: TrackRowData): string {
  const raw = track[col.id];
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
 */
export function TrackRow({
  track,
  active,
  selected,
  selecting,
  style,
  onSelect,
  onToggle,
}: {
  track: TrackRowData;
  active: boolean;
  selected: boolean;
  selecting: boolean;
  style: CSSProperties;
  onSelect: (track: TrackRowData) => void;
  onToggle: (trackId: number, modifiers: SelectModifiers) => void;
}) {
  const t = useT();

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
        return (
          <span key={col.id} className={cellClass(col, text === "-")} title={text}>
            {text}
          </span>
        );
      })}
    </div>
  );
}
