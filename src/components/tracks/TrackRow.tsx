// -- Framework Imports --
import type { CSSProperties } from "react";

// -- Utils Imports --
import { trackColumns } from "./trackColumns";
import type { TrackColumn } from "./trackColumns";

// -- Type Imports --
import type { TrackRow as TrackRowData } from "../../types";

// -- Style Imports --
import styles from "./TrackRow.module.css";

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
 * column model and reports a click. Hover and the active peek show as a soft veil, never a border.
 */
export function TrackRow({
  track,
  active,
  style,
  onSelect,
}: {
  track: TrackRowData;
  active: boolean;
  style: CSSProperties;
  onSelect: (track: TrackRowData) => void;
}) {
  return (
    <div
      className={`${styles.row} ${active ? styles.active : ""}`}
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
