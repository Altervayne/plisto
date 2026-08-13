/*
 * The grid's column model, in one place so the header and the rows render from the same source.
 * Plain data plus the derived TanStack column defs; no JSX lives here. Widths drive a single CSS
 * grid template shared by the header and every row, so columns line up without a table element.
 */

// -- Library Imports --
import type { ColumnDef, FilterFn } from "@tanstack/react-table";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { TrackRow } from "../../types";

/** The ink weight a cell carries: the one title anchor, the secondary tags, or quiet meta. */
export type CellInk = "primary" | "secondary" | "meta";

/** How a column's text sits horizontally. Numerics align right so digits stack. */
export type CellAlign = "left" | "right";

/** One visible column: its row key, label, track width, and how its cell reads. */
export interface TrackColumn {
  id: keyof TrackRow;
  header: string;
  /** Fixed track width in px for meta and numeric columns; null lets a text column flex. */
  width: number | null;
  /** Flex weight when width is null, so title claims more room than artist or album. */
  grow: number;
  align: CellAlign;
  ink: CellInk;
  /** The lone mono cell marks the raw source filename. */
  mono?: boolean;
  /** Digits that stack down the column align via tabular-nums. */
  tabular?: boolean;
  /** The format tag reads as an uppercase micro-label, not a chip and not mono. */
  upper?: boolean;
  /** Turns a raw value into its display string; a plain value falls through to a dash for null. */
  format?: (value: TrackRow[keyof TrackRow]) => string;
  /** Whether the global search reaches this column. Only the text tags and filename do. */
  searchable?: boolean;
}

/** Left-to-right column order for the default row. Album artist, disc, and genre live in the peek. */
export const trackColumns: TrackColumn[] = [
  { id: "raw_track_no", header: "No", width: 52, grow: 0, align: "right", ink: "meta", tabular: true },
  { id: "raw_title", header: "Title", width: null, grow: 2, align: "left", ink: "primary", searchable: true },
  { id: "raw_artist", header: "Artist", width: null, grow: 1.4, align: "left", ink: "secondary", searchable: true },
  { id: "raw_album", header: "Album", width: null, grow: 1.4, align: "left", ink: "secondary", searchable: true },
  { id: "raw_year", header: "Year", width: 60, grow: 0, align: "right", ink: "meta", tabular: true },
  {
    id: "duration_secs",
    header: "Length",
    width: 72,
    grow: 0,
    align: "right",
    ink: "meta",
    tabular: true,
    format: (value) => formatDuration(value as number | null),
  },
  { id: "ext", header: "Format", width: 78, grow: 0, align: "left", ink: "meta", upper: true },
  { id: "filename", header: "File", width: null, grow: 1.6, align: "left", ink: "meta", mono: true, searchable: true },
];

/** The shared `grid-template-columns` value: fixed px for meta, `fr` weights for flexing text. */
export function gridTemplate(columns: TrackColumn[] = trackColumns): string {
  return columns
    .map((col) => (col.width == null ? `minmax(0, ${col.grow}fr)` : `${col.width}px`))
    .join(" ");
}

/** Case-insensitive substring match, run only over the columns flagged searchable. */
export const trackGlobalFilter: FilterFn<TrackRow> = (row, columnId, value) => {
  const cell = row.getValue(columnId);
  if (cell == null) return false;
  return String(cell).toLowerCase().includes(String(value).toLowerCase());
};

/** Derives the TanStack column defs from the visible columns: sorting on all, search on the text tags. */
export function toColumnDefs(columns: TrackColumn[] = trackColumns): ColumnDef<TrackRow>[] {
  return columns.map((col) => ({
    id: col.id,
    accessorKey: col.id,
    header: col.header,
    enableSorting: true,
    enableGlobalFilter: col.searchable ?? false,
  }));
}
